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

/**
 * Wrap a durable out-stream of frames as a `text/event-stream`. Each frame becomes one
 * `data: <json>\n\n` event; the stream stays open (live) until the relay run closes it or the
 * client disconnects. A leading comment opens the stream so intermediaries flush headers promptly.
 */
export function sseResponse(source: ReadableStream<unknown>): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        controller.enqueue(encoder.encode(": open\n\n"));
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
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
