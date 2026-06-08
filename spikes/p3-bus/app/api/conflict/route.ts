import { start, getRun } from "workflow/api";
import { conflictProbeWorkflow } from "@/workflows/conflict-probe";
import { drain } from "@/lib/drain";

export const maxDuration = 60;

// Starts a probe run that tries to createHook on `token`. If a live bus already holds that
// token, the probe should catch HookConflictError and report it on its own out-stream.
export async function POST(req: Request) {
  const { token } = await req.json();
  if (!token) return Response.json({ error: "missing token" }, { status: 400 });

  const run = await start(conflictProbeWorkflow, [token]);
  const stream = getRun(run.runId).getReadable({ startIndex: 0 });
  const report = await drain(stream as ReadableStream<unknown>, 8000, 5);

  let status: unknown = undefined;
  try {
    status = await getRun(run.runId).status;
  } catch {
    /* ignore */
  }
  return Response.json({ probeRunId: run.runId, status, report });
}
