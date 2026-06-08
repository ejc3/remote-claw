import { getHookByToken, getRun } from "workflow/api";

export const maxDuration = 60;

// Inspect a run's status and/or whether a token still resolves to a live hook.
// After a __close (bus completes), the run should be "completed" and getHookByToken 404s.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const token = url.searchParams.get("token");

  const result: Record<string, unknown> = {};

  if (runId) {
    const run = getRun(runId);
    try {
      result.exists = await run.exists;
      result.status = await run.status;
    } catch (e) {
      result.runError = String((e as Error)?.message ?? e);
    }
  }

  if (token) {
    try {
      const hook = await getHookByToken(token);
      result.tokenResolves = true;
      result.tokenRunId = hook.runId;
    } catch {
      result.tokenResolves = false;
    }
  }

  return Response.json(result);
}
