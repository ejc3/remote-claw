import { getHookByToken, getRun } from "workflow/api";
import { drain } from "@/lib/drain";

export const maxDuration = 60;

// Cross-process subscribe: resolve a derived token to its run via getHookByToken, then tail
// that run's out-stream via getRun(runId).getReadable({startIndex}). Drains a bounded window
// so curl gets JSON. This is the exact §6B composition under test.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return Response.json({ error: "missing token" }, { status: 400 });

  const startIndexParam = url.searchParams.get("startIndex");
  const startIndex = startIndexParam != null ? parseInt(startIndexParam, 10) : undefined;
  const budgetMs = parseInt(url.searchParams.get("ms") ?? "3000", 10);

  let runId: string;
  try {
    const hook = await getHookByToken(token);
    runId = hook.runId;
  } catch {
    return Response.json({ resolved: false, reason: "HookNotFound", items: [] });
  }

  const run = getRun(runId);
  const stream = run.getReadable(startIndex !== undefined ? { startIndex } : {});
  const getTail = (stream as { getTailIndex?: () => Promise<number> }).getTailIndex;
  const tailIndex = typeof getTail === "function" ? await getTail.call(stream) : undefined;

  const items = await drain(stream as ReadableStream<unknown>, budgetMs, 200);
  return Response.json({ resolved: true, runId, startIndex, tailIndex, count: items.length, items });
}
