import { start, resumeHook, getHookByToken } from "workflow/api";
import { busWorkflow } from "@/workflows/bus";

export const maxDuration = 60;

async function ensureBus(token: string): Promise<{ runId: string; created: boolean }> {
  try {
    const hook = await getHookByToken(token);
    return { runId: hook.runId, created: false };
  } catch {
    // No live bus for this token -> create one, then wait for its hook to register.
    await start(busWorkflow, [token]);
    for (let i = 0; i < 60; i++) {
      try {
        const hook = await getHookByToken(token);
        return { runId: hook.runId, created: true };
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("bus hook did not appear within timeout after start()");
  }
}

export async function POST(req: Request) {
  const { token, msg } = await req.json();
  if (!token) return Response.json({ error: "missing token" }, { status: 400 });
  const { runId, created } = await ensureBus(token);
  await resumeHook(token, msg ?? {});
  return Response.json({ ok: true, runId, busCreated: created });
}
