// Read a live WorkflowReadableStream into a JSON array, bounded by a time budget and a max
// count, so HTTP clients (curl) get a finite response instead of hanging on a live stream.
export async function drain(
  stream: ReadableStream<unknown>,
  ms: number,
  max: number,
): Promise<unknown[]> {
  const reader = stream.getReader();
  const out: unknown[] = [];
  const deadline = Date.now() + ms;
  try {
    while (out.length < max) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Clear the timeout the moment read() wins, or it leaks a live timer that keeps the
      // serverless function's event loop alive (a fresh one would leak every iteration).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timeout: true }>((r) => {
        timer = setTimeout(() => r({ timeout: true }), remaining);
      });
      let res: { timeout: true } | ReadableStreamReadResult<unknown>;
      try {
        res = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if ((res as { timeout?: true }).timeout) break;
      const { done, value } = res as ReadableStreamReadResult<unknown>;
      if (done) {
        // The underlying stream signaled close (the bus called getWritable().close() after
        // __close). This marks THIS drain hit a closed stream — it is not the authoritative
        // "bus is gone" signal; that's getHookByToken 404 / run "completed" (CHECK 4).
        out.push({ __eof: true });
        break;
      }
      out.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return out;
}
