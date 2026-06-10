// The browser viewer: a thin, framework-free wrapper over the SHARED transport (@remote-claw/cli/broker)
// for the things a phone/laptop driver does — discover sessions on the bus, tail a session's
// transcript, ask for history, and send a prompt. It reuses the exact BrokerClient / FrameOrderer /
// SecurityProvider the host uses, so there is no second protocol implementation to drift.

import { type FrameHeader, type Identity, parsePass, utf8 } from "@remote-claw/clawsec";
import {
  BrokerClient,
  type BrokerClientOptions,
  FrameOrderer,
  securityProvider,
} from "@remote-claw/cli/broker";

const td = new TextDecoder();

/** Presence: a session is "online" iff its latest announce's sent_at is within this window (§4.3).
 *  Also the freshness bound for control verbs (§3.7) — a verb the broker withholds past it is a
 *  no-op, so it can't replay a stale interrupt/set_mode/end. */
export const FRESH_WINDOW_MS = 60_000;

/** A decrypted session_announce from the bus. */
export interface Announce {
  sessionId: string;
  title: string;
  cwd: string | null;
  sentAt: number;
}

/** A decrypted transcript message from a session's out-stream. */
export interface Message {
  kind: string;
  seq: number | null;
  text: string;
  msgId: string;
}

export class Viewer {
  readonly #client: BrokerClient;
  readonly #identityId: Uint8Array;

  private constructor(identity: Identity, baseUrl: string, fetchFn?: typeof fetch) {
    this.#identityId = identity.identityId;
    const opts: BrokerClientOptions = {
      baseUrl,
      provider: securityProvider("sealed", identity),
    };
    // exactOptionalPropertyTypes: only set fetchFn when a custom one is supplied (tests).
    if (fetchFn !== undefined) opts.fetchFn = fetchFn;
    this.#client = new BrokerClient(opts);
  }

  /**
   * Build a viewer from a pasted/fragment pass (`rcp1_…`). Throws PassError on a bad pass. `baseUrl`
   * defaults to same-origin (""); `fetchFn` is for tests (defaults to the global fetch).
   */
  static async fromPass(pass: string, baseUrl = "", fetchFn?: typeof fetch): Promise<Viewer> {
    return new Viewer(await parsePass(pass.trim()), baseUrl, fetchFn);
  }

  #header(
    extra: Partial<FrameHeader> & Pick<FrameHeader, "recordKind" | "sessionId" | "msgId">,
  ): FrameHeader {
    return {
      v: 1,
      identityId: this.#identityId,
      dir: "in",
      seq: null,
      keyEpoch: 0,
      part: 0,
      parts: 1,
      ...extra,
    };
  }

  /**
   * Tail the identity bus; yield each fresh session_announce (decrypted under K_meta). Re-subscribes
   * when the stream ends: the bus run may not exist yet (you opened the app before any host
   * announced) or may have cap-rolled. Consumers key presence by session_id + sent_at, so a
   * re-yielded announce across a reconnect is harmless. Loops until `signal` aborts.
   */
  async *announces(signal: AbortSignal): AsyncGenerator<Announce> {
    while (!signal.aborted) {
      try {
        for await (const frame of this.#client.streamFrames({ startIndex: -64, signal })) {
          if (frame.recordKind !== "session_announce") continue;
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(td.decode(await this.#client.openFrame(frame)));
          } catch {
            continue; // a frame we can't open/parse (not ours / corrupt) — skip, never crash the list
          }
          yield {
            sessionId: String(body.session_id ?? frame.sessionId),
            title: typeof body.title === "string" ? body.title : String(body.session_id ?? ""),
            cwd: typeof body.cwd === "string" ? body.cwd : null,
            sentAt: typeof body.sent_at === "number" ? body.sent_at : 0,
          };
        }
      } catch {
        // A transient stream error (network blip / SSE reset / broker 5xx) must NOT end discovery —
        // fall through to the resume-or-retry sleep and re-subscribe, exactly like the relay does.
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, 150)); // bus run not up / stream closed → resume-or-retry
    }
  }

  /**
   * Tail a session's out-stream; yield decoded transcript messages (deduped + reordered by seq).
   * Re-subscribes when the stream ends: the session run may not exist yet (you opened the session
   * before the host posted anything) or may have cap-rolled (the "window rolling over"). The
   * FrameOrderer persists across re-subscribes; for CONTENT frames its seq cursor (drops seq < next)
   * is what guarantees no gap and no duplicate on the re-read — the bounded msg_id window only de-dups
   * the seq===null meta frames (e.g. `accepted`), which are idempotent to re-yield (rendered as
   * nothing) even if the window evicts on a very long session. Loops until `signal` aborts.
   */
  async *transcript(sessionId: string, signal: AbortSignal): AsyncGenerator<Message> {
    const orderer = new FrameOrderer();
    while (!signal.aborted) {
      // Re-read from the start of the run; the orderer's dedup window drops everything already
      // delivered, so the re-subscribe is idempotent. (startIndex is a broker FRAME index — which
      // counts in/out/meta/chunk frames — not the transcript seq, so the orderer, not startIndex,
      // is what guarantees no gap and no duplicate across a reconnect.)
      try {
        for await (const frame of this.#client.streamFrames({
          session: sessionId,
          startIndex: 0,
          signal,
        })) {
          if (frame.dir !== "out") continue; // the viewer renders host→web frames only
          // The orderer releases a chunked message (parts > 1) as its parts together, in part order — so
          // reassemble those with openMessage; a single frame opens directly.
          const ready = orderer.accept(frame);
          for (let i = 0; i < ready.length; ) {
            const f = ready[i];
            if (f === undefined) break;
            const span = f.parts > 1 ? f.parts : 1;
            const group = ready.slice(i, i + span);
            i += span;
            let text: string;
            try {
              text = td.decode(
                span > 1 ? await this.#client.openMessage(group) : await this.#client.openFrame(f),
              );
            } catch {
              continue; // a frame/message we can't open (not ours / corrupt) — skip, never crash the list
            }
            yield { kind: f.recordKind, seq: f.seq, text, msgId: f.msgId };
          }
        }
      } catch {
        // A transient stream error must NOT end the transcript — fall through to resume-or-retry and
        // re-subscribe. The persistent FrameOrderer makes the re-read idempotent (no gap, no dup).
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, 150)); // run not up / stream closed → resume-or-retry
    }
  }

  /** Ask the host to replay history from `since` (a control frame on the session channel). */
  async requestHistory(sessionId: string, since = 0): Promise<void> {
    await this.#client.postFrame(
      this.#header({ recordKind: "catch_up", sessionId, msgId: `catchup-${since}-${randomId()}` }),
      utf8(JSON.stringify({ since, expiry: Date.now() + FRESH_WINDOW_MS })),
    );
  }

  /**
   * Grant or deny a worker `can_use_tool` request (a `permission` control frame, dir:in). The host
   * answers the worker's control_request with the chosen behavior. `requestId` comes from the
   * `permission_request` transcript frame the host relayed.
   */
  async grantPermission(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny" = "allow",
  ): Promise<void> {
    // An empty request_id can't match any worker control_request — never seal a useless frame.
    if (requestId === "") throw new Error("grantPermission: empty requestId");
    await this.#client.postFrame(
      this.#header({
        recordKind: "permission",
        sessionId,
        msgId: `perm-${requestId}-${randomId()}`,
      }),
      utf8(JSON.stringify({ request_id: requestId, behavior })),
    );
  }

  /** Post a control-verb frame (dir:in) the host forwards to the worker as a control_request (§3.7).
   *  Stamps `expiry` so a control action the broker withholds and replays later is dropped as stale. */
  async #control(
    sessionId: string,
    kind: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#client.postFrame(
      this.#header({ recordKind: kind, sessionId, msgId: `${kind}-${randomId()}` }),
      utf8(JSON.stringify({ ...body, expiry: Date.now() + FRESH_WINDOW_MS })),
    );
  }

  /** Interrupt the current turn (the remote ESC). */
  async interrupt(sessionId: string): Promise<void> {
    await this.#control(sessionId, "interrupt");
  }

  /** Switch the session's model mid-flight (e.g. "claude-opus-4-8"). */
  async setModel(sessionId: string, model: string): Promise<void> {
    await this.#control(sessionId, "set_model", { model });
  }

  /** Change the permission mode (default | acceptEdits | plan | bypassPermissions | …). */
  async setMode(sessionId: string, mode: string): Promise<void> {
    await this.#control(sessionId, "set_mode", { mode });
  }

  /** End the session from the remote. */
  async endSession(sessionId: string): Promise<void> {
    await this.#control(sessionId, "end");
  }

  /** Run a slash command (`/compact`, `/clear`, `/context`, …). claude processes it as input, so it
   *  rides the SAME `user` path as a prompt — acked + echoed to every device, replayable via catch_up
   *  (a control frame would skip all three). Returns its client_msg_id. */
  async command(sessionId: string, text: string): Promise<string> {
    return this.sendPrompt(sessionId, text);
  }

  /** Send a prompt to the session (a `user` content frame, dir:in). Returns its client_msg_id. */
  async sendPrompt(sessionId: string, text: string): Promise<string> {
    const clientMsgId = `c-${randomId()}`;
    await this.#client.postFrame(
      this.#header({ recordKind: "user", sessionId, msgId: clientMsgId, clientMsgId }),
      utf8(text),
    );
    return clientMsgId;
  }
}

/** A short random id (browser + Node 22 both expose WebCrypto). */
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join("");
}
