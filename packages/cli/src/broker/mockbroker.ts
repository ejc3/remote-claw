// An in-memory stand-in for the §3.2 routes, used to unit-test BrokerClient without the Workflow
// runtime. It mimics the contract the real broker tests already verify: Bearer-gated, value-addressed
// by channel (bus vs ?session), and SSE on subscribe. Each subscribe returns a FINITE event-stream of
// the frames buffered so far (then closes), which is enough to drive the client's parse/decode path;
// the real end-to-end liveness is covered by the apps/web integration tests.

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
  /** Every POST seen, for assertions about routing/auth. */
  readonly posts: PostRecord[] = [];
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
      list.push(frame);
      this.#channels.set(token, list);
      return json({ ok: true, channel, runId: "mock-run", created: list.length === 1 });
    }

    if (url.pathname === "/api/stream") {
      const token = session === null ? "bus" : `sess:${session}`;
      const all = this.#channels.get(token) ?? [];
      const startIndex = url.searchParams.get("startIndex");
      const from =
        startIndex === null ? 0 : resolveStart(Number.parseInt(startIndex, 10), all.length);
      return sse(all.slice(from));
    }

    if (url.pathname === "/api/seq") {
      const token = session === null ? "bus" : `sess:${session}`;
      const all = this.#channels.get(token) ?? [];
      const maxSeq = all.reduce<number | null>((max, frame) => {
        if (typeof frame.seq !== "number") return max;
        return max === null ? frame.seq : Math.max(max, frame.seq);
      }, null);
      return json({ maxSeq });
    }

    if (url.pathname === "/api/frame-count") {
      const token = session === null ? "bus" : `sess:${session}`;
      return json({ frameCount: this.#channels.get(token)?.length ?? null });
    }

    return json({ error: "not found" }, 404);
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

/** A finite event-stream of the given frames, then close (enough to drive the client's parser). */
function sse(frames: WireFrame[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(": open\n\n"));
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
