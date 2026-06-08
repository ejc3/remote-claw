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
      const res = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((r) =>
          setTimeout(() => r({ timeout: true }), remaining),
        ),
      ]);
      if ((res as { timeout?: true }).timeout) break;
      const { done, value } = res as ReadableStreamReadResult<unknown>;
      if (done) {
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
