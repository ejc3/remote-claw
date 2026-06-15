// Shared HTTP helpers for the two broker routes: JSON replies and the SSE framing for /api/stream.

/** A JSON response with the given status. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    // No buffering/transforms — proxies must flush each frame immediately, and the browser must
    // not cache a live stream.
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  };
}

const encoder = new TextEncoder();

/** How often an idle SSE stream emits a `: ping` keepalive comment. A healthy stream therefore sends
 *  bytes at least this often even with no frames, so the client's idle-watchdog (`SSE_IDLE_MS` in
 *  `BrokerClient`, sized well above this) can tell "alive but idle" from "dead/suspended" and only
 *  reconnect on a genuine stall. Also keeps proxies/load-balancers from reaping an idle connection. */
export const SSE_KEEPALIVE_MS = 15_000;
const SSE_PING = Symbol("sse-ping");

/**
 * Wrap a durable out-stream of frames as a `text/event-stream`. Each frame becomes one
 * `data: <json>\n\n` event; the stream stays open (live) until the relay run closes it or the
 * client disconnects. A leading comment opens the stream so intermediaries flush headers promptly,
 * and a `: ping` is emitted every {@link SSE_KEEPALIVE_MS} while idle (see that constant).
 */
export function sseResponse(
  source: ReadableStream<unknown>,
  keepaliveMs = SSE_KEEPALIVE_MS,
): Response {
  // Hoisted so the body's cancel() (fired when the HTTP client disconnects) can interrupt the start()
  // loop's pending read(): cancelling the reader cancels `source`, which lets a fan-out backend (the
  // in-process LocalBackend) drop THIS subscriber. Without it, an idle disconnect leaves start()
  // blocked on read() forever and the subscriber is never released.
  let reader: ReadableStreamDefaultReader<unknown> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      try {
        controller.enqueue(encoder.encode(": open\n\n"));
        // Race each read against a keepalive timer, holding the SAME read promise across pings so a
        // ping never drops a frame. An idle stream still emits `: ping` every SSE_KEEPALIVE_MS.
        let readPromise = reader.read();
        for (;;) {
          let pingTimer: ReturnType<typeof setTimeout> | undefined;
          const ping = new Promise<typeof SSE_PING>((resolve) => {
            pingTimer = setTimeout(() => resolve(SSE_PING), keepaliveMs);
          });
          const winner = await Promise.race([readPromise, ping]);
          clearTimeout(pingTimer);
          if (winner === SSE_PING) {
            controller.enqueue(encoder.encode(": ping\n\n")); // readPromise is still pending
            continue;
          }
          if (winner.done) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(winner.value)}\n\n`));
          readPromise = reader.read();
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(msg)}\n\n`));
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        controller.close();
      }
    },
    async cancel() {
      try {
        await reader?.cancel();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(body, { status: 200, headers: sseHeaders() });
}

/**
 * The "nothing connected" reply (§6B): a 200 event-stream that emits a single comment and closes,
 * so an absent/offline/mismatched identity is indistinguishable from a connected-but-silent one —
 * status never leaks an offline identity.
 */
export function sseEmptyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": empty\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: sseHeaders() });
}
