import type { Client } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import { type BrokerBackend, isClose, type PublishResult, type RelayPayload } from "./backend";
import { ensureSchema, tursoClientFromEnv, tursoPollMs } from "./turso-connection";

// The Turso (libSQL) durable backend — the SINGLE shared, durable log behind the two broker routes,
// selected with BROKER_BACKEND=turso or `?backend=turso`. A channel token addresses one append-only
// `frames` log: the wrapper appends its out-frames and a client appends its in-frames (prompts,
// permission answers) to the SAME log, and both tail it — all via /api/relay + /api/stream (the broker
// mediates; neither side talks to Turso directly, so the wrapper stays a plain broker client). Unlike
// the in-process Local / capped Vercel / Temporal backends, this log is DURABLE + unbounded, so history
// survives a wrapper restart (the basis for retiring the in-memory #log / #36 in a later phase).
//
// E2E: `frame` stores the verbatim sealed WireFrame JSON — the broker never decrypts; the routing
// columns are the §8 cleartext header it already routes on. (Durable at-rest ciphertext is the accepted
// forward-secrecy tradeoff vs the ephemeral backends; a retention sweep is later work.)
//
// subscribe() POLLS (libSQL has no push): it replays history then tails live from the SAME monotonic
// `id` cursor — one query, no replay→live boundary, so a frame is never skipped or re-sent.

export class TursoBackend implements BrokerBackend {
  readonly #client: Client;
  readonly #pollMs = tursoPollMs();

  /** Production uses the env-configured singleton; tests inject a `file:`/`:memory:` client. */
  constructor(client?: Client) {
    this.#client = client ?? tursoClientFromEnv();
  }

  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    const c = this.#client;
    await ensureSchema(c);

    if (isClose(payload)) {
      // Mark an EXISTING live channel closed — do NOT delete its rows: a buffered replay must still
      // survive a close, and the history is the whole point of going durable. A later publish reopens a
      // fresh incarnation (gen+1). No-op if the token is absent or already closed.
      await c.execute({
        sql: "UPDATE channels SET closed = 1 WHERE token = ? AND closed = 0",
        args: [token],
      });
      return { created: false, channelId: token };
    }

    return this.#publishFrame(token, payload as Partial<WireFrame>);
  }

  /**
   * Resolve-or-start the channel AND append the frame in ONE write transaction (BEGIN IMMEDIATE → the
   * write lock serializes against a concurrent publish/__close). Doing both atomically is what makes the
   * frame's gen and its insert consistent: a frame can never land in a gen that a racing __close just
   * closed (which would orphan it — a subscriber reads only the live gen). create if absent, reuse if
   * live, reopen with a bumped `gen` if closed (a recycled token reports created=true and a new
   * subscriber sees only the new incarnation's frames — the LocalBackend close-frees-token contract,
   * kept durable). Because the channel is guaranteed live before the insert, there is no
   * publish-into-disposed race to surface as a 409 (PublishConflictError) the way the Vercel/Temporal
   * cap-roll backends have.
   */
  async #publishFrame(token: string, wire: Partial<WireFrame>): Promise<PublishResult> {
    const tx = await this.#client.transaction("write");
    try {
      const sel = await tx.execute({
        sql: "SELECT gen, closed FROM channels WHERE token = ?",
        args: [token],
      });
      const row = sel.rows[0];
      let created: boolean;
      let gen: number;
      if (row === undefined) {
        gen = 0;
        created = true;
        await tx.execute({
          sql: "INSERT INTO channels (token, gen, closed, created_at) VALUES (?, 0, 0, ?)",
          args: [token, Date.now()],
        });
      } else if (Number(row.closed) === 0) {
        gen = Number(row.gen);
        created = false;
      } else {
        gen = Number(row.gen) + 1;
        created = true;
        await tx.execute({
          sql: "UPDATE channels SET gen = ?, closed = 0 WHERE token = ?",
          args: [gen, token],
        });
      }
      await tx.execute({
        // `?? null` (nullish, NOT `||`) preserves a legitimate seq=0 / part=0; only an absent field → NULL
        // (the minimal test frames). UNIQUE(token,gen,msg_id,part) + ON CONFLICT makes a deterministic-
        // msg_id re-POST idempotent; a NULL msg_id is distinct in SQLite, so a frame without one always
        // inserts.
        sql: `INSERT INTO frames (token, gen, seq, msg_id, part, frame, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (token, gen, msg_id, part) DO NOTHING`,
        args: [
          token,
          gen,
          wire.seq ?? null,
          wire.msg_id ?? null,
          wire.part ?? null,
          JSON.stringify(wire), // the opaque sealed frame — never decrypted here
          Date.now(),
        ],
      });
      await tx.commit();
      return { created, channelId: token };
    } catch (e) {
      try {
        await tx.rollback();
      } catch {
        /* already settled */
      }
      throw e;
    }
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    const c = this.#client;
    await ensureSchema(c);

    const ch = await c.execute({
      sql: "SELECT gen, closed FROM channels WHERE token = ?",
      args: [token],
    });
    const meta = ch.rows[0];
    // Absent OR closed → null ⇒ the route replies 200-empty (subscribing never creates a channel).
    if (meta === undefined || Number(meta.closed) === 1) return null;
    const gen = Number(meta.gen);

    // Resolve an `id` cursor such that `id > cursor` selects from the requested start. undefined/0 → the
    // whole log (ids start at 1); positive → skip the first N rows of this gen (clamp past-end → head);
    // negative → the last |N| rows.
    let absStart = 0;
    if (startIndex !== undefined) {
      if (startIndex >= 0) {
        absStart = startIndex;
      } else {
        const cnt = await c.execute({
          sql: "SELECT COUNT(*) AS n FROM frames WHERE token = ? AND gen = ?",
          args: [token, gen],
        });
        absStart = Math.max(0, Number(cnt.rows[0]?.n ?? 0) + startIndex);
      }
    }
    let cursor = 0;
    if (absStart > 0) {
      const at = await c.execute({
        sql: "SELECT id FROM frames WHERE token = ? AND gen = ? ORDER BY id LIMIT 1 OFFSET ?",
        args: [token, gen, absStart - 1],
      });
      if (at.rows[0] !== undefined) {
        cursor = Number(at.rows[0].id);
      } else {
        // startIndex past the end → clamp to head: replay nothing, then stream new frames.
        const mx = await c.execute({
          sql: "SELECT COALESCE(MAX(id), 0) AS m FROM frames WHERE token = ? AND gen = ?",
          args: [token, gen],
        });
        cursor = Number(mx.rows[0]?.m ?? 0);
      }
    }

    let stopped = false;
    const pollMs = this.#pollMs;
    return new ReadableStream<WireFrame>({
      pull: async (controller) => {
        while (!stopped) {
          const res = await c.execute({
            sql: "SELECT id, frame FROM frames WHERE token = ? AND gen = ? AND id > ? ORDER BY id LIMIT 500",
            args: [token, gen, cursor],
          });
          if (stopped) return; // cancelled while the query was in flight
          if (res.rows.length > 0) {
            let lastId = cursor;
            try {
              for (const r of res.rows) {
                controller.enqueue(JSON.parse(r.frame as string) as WireFrame);
                lastId = Number(r.id);
              }
            } catch {
              return; // controller already closed (a racing cancel)
            }
            cursor = lastId;
            return;
          }
          // No new frames for this incarnation. End the stream if the channel was closed or recycled to a
          // newer gen (the buffered replay above has already drained); else wait and poll again.
          const st = await c.execute({
            sql: "SELECT closed, gen FROM channels WHERE token = ?",
            args: [token],
          });
          const s = st.rows[0];
          if (s === undefined || Number(s.closed) === 1 || Number(s.gen) !== gen) {
            controller.close();
            return;
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      },
      cancel: () => {
        stopped = true;
      },
    });
  }
}
