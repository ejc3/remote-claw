// An in-memory stand-in for the §3.2 routes, used to unit-test BrokerClient without the Workflow
// runtime. It mimics the contract the real broker tests already verify: Bearer-gated, value-addressed
// by channel (bus vs ?session), and replay-then-live SSE on subscribe. An absent channel alone emits
// `: empty` + EOF; an existing channel emits `: open`, its buffered prefix, and future appends until
// the consumer cancels. That distinction is safety-relevant to the host's inbound failure circuit.

import { toHex, type WireFrame } from "@remote-claw/clawsec";

interface PostRecord {
  channel: "bus" | "session";
  session: string | null;
  bearer: string | null;
  frame: WireFrame;
}

export class MockBroker {
  /** channel token → frames published to it, in order. */
  readonly #channels = new Map<string, WireFrame[]>();
  /** Absorbing presence state, keyed by this mock's channel token. Mirrors the real broker fence. */
  readonly #presenceTerminals = new Map<string, Set<string>>();
  /** Live stream listeners, keyed by channel token. */
  readonly #subscribers = new Map<string, Set<(frame: WireFrame) => void>>();
  /** Every POST seen, for assertions about routing/auth. */
  readonly posts: PostRecord[] = [];
  /** Server-reported default durability when no backend selector is sent. */
  durable = false;
  /** When set, the bearer hex an authorized request must present (else 401). */
  #requireBearer: string | null = null;

  /** Require this exact auth_token (bytes) on every request, returning 401 otherwise. */
  requireAuth(authToken: Uint8Array): void {
    this.#requireBearer = toHex(authToken);
  }

  /** A `fetch`-compatible function bound to this mock, to inject into BrokerClient. */
  get fetch(): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(input, init)) as typeof fetch;
  }

  #bearerOf(init: RequestInit | undefined): string | null {
    const h = new Headers(init?.headers);
    const auth = h.get("authorization");
    const m = auth === null ? null : /^Bearer (.+)$/.exec(auth);
    return m === null ? null : (m[1] as string);
  }

  #unauthorized(bearer: string | null): boolean {
    return this.#requireBearer !== null && bearer !== this.#requireBearer;
  }

  #durableFor(init: RequestInit | undefined): boolean {
    const backend = new Headers(init?.headers).get("x-broker-backend")?.trim();
    return backend === "sqlite" || (backend === undefined && this.durable);
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const session = url.searchParams.get("session");
    const bearer = this.#bearerOf(init);
    if (this.#unauthorized(bearer)) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/api/relay" && (init?.method ?? "GET") === "POST") {
      const frame = JSON.parse(String(init?.body ?? "{}")) as WireFrame;
      const channel: "bus" | "session" = session === null ? "bus" : "session";
      this.posts.push({ channel, session, bearer, frame });
      const token = session === null ? "bus" : `sess:${session}`;
      const list = this.#channels.get(token) ?? [];
      const terminals = this.#presenceTerminals.get(token) ?? new Set<string>();
      let appended = false;
      if (session === null && frame.record_kind === "session_terminal") {
        if (!terminals.has(frame.session_id)) {
          terminals.add(frame.session_id);
          list.push(frame);
          appended = true;
        }
        this.#presenceTerminals.set(token, terminals);
      } else if (
        session !== null ||
        frame.record_kind !== "session_announce" ||
        !terminals.has(frame.session_id)
      ) {
        list.push(frame);
        appended = true;
      }
      this.#channels.set(token, list);
      if (appended) {
        const subscribers = this.#subscribers.get(token);
        if (subscribers !== undefined) {
          for (const subscriber of [...subscribers]) {
            try {
              subscriber(frame);
            } catch {
              subscribers.delete(subscriber);
            }
          }
          if (subscribers.size === 0) this.#subscribers.delete(token);
        }
      }
      return json({ ok: true, channel, runId: "mock-run", created: appended && list.length === 1 });
    }

    if (url.pathname === "/api/stream") {
      const token = session === null ? "bus" : `sess:${session}`;
      const all = this.#channels.get(token);
      if (all === undefined) return sseEmpty();
      const startIndex = url.searchParams.get("startIndex");
      const from =
        startIndex === null ? 0 : resolveStart(Number.parseInt(startIndex, 10), all.length);
      return this.#sse(token, all.slice(from));
    }

    if (url.pathname === "/api/seq") {
      const token = session === null ? "bus" : `sess:${session}`;
      const all = this.#channels.get(token) ?? [];
      const maxSeq = all.reduce<number | null>((max, frame) => {
        if (typeof frame.seq !== "number") return max;
        return max === null ? frame.seq : Math.max(max, frame.seq);
      }, null);
      return json({ maxSeq, durable: this.#durableFor(init) });
    }

    if (url.pathname === "/api/frame-count") {
      const token = session === null ? "bus" : `sess:${session}`;
      return json({
        frameCount: this.#channels.get(token)?.length ?? null,
        durable: this.#durableFor(init),
      });
    }

    return json({ error: "not found" }, 404);
  }

  #sse(token: string, frames: WireFrame[]): Response {
    const enc = new TextEncoder();
    let listener: ((frame: WireFrame) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(enc.encode(": open\n\n"));
        for (const frame of frames) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        listener = (frame) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
        };
        const subscribers = this.#subscribers.get(token) ?? new Set();
        subscribers.add(listener);
        this.#subscribers.set(token, subscribers);
      },
      cancel: () => {
        if (listener === undefined) return;
        const subscribers = this.#subscribers.get(token);
        subscribers?.delete(listener);
        if (subscribers?.size === 0) this.#subscribers.delete(token);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
}

/** Resolve a possibly-negative startIndex against the buffered length (like getReadable). */
function resolveStart(startIndex: number, length: number): number {
  if (Number.isNaN(startIndex)) return 0;
  return startIndex < 0 ? Math.max(0, length + startIndex) : Math.min(startIndex, length);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseEmpty(): Response {
  return new Response(": empty\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
