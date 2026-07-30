import { getHookByToken, resumeHook, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { busWorkflow } from "@/workflows/bus";

export const maxDuration = 60;

function hookLookupFailure(): Error {
	return new Error("workflow hook lookup failed");
}

function hookStartFailure(): Error {
	return new Error("workflow hook start failed");
}

async function ensureBus(
	token: string,
): Promise<{ runId: string; created: boolean }> {
	try {
		const hook = await getHookByToken(token);
		return { runId: hook.runId, created: false };
	} catch (error) {
		if (!HookNotFoundError.is(error)) throw hookLookupFailure();
		// No live bus for this token -> create one, then wait for its hook to register.
		try {
			await start(busWorkflow, [token]);
		} catch {
			throw hookStartFailure();
		}
		for (let i = 0; i < 60; i++) {
			try {
				const hook = await getHookByToken(token);
				return { runId: hook.runId, created: true };
			} catch (error) {
				if (!HookNotFoundError.is(error)) throw hookLookupFailure();
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
	// The bus run can complete/dispose between ensureBus resolving and this resume. Only Workflow's
	// typed vanished-hook error is that retryable race; serialization, persistence, queue, and other
	// failures keep hard-failure semantics with provider details redacted because those can contain
	// the full channel token.
	try {
		await resumeHook(token, msg ?? {});
	} catch (e) {
		if (HookNotFoundError.is(e)) {
			return Response.json(
				{
					ok: false,
					error: "workflow channel disappeared during publish",
					runId,
					busCreated: created,
				},
				{ status: 409 },
			);
		}
		throw new Error("workflow channel delivery failed");
	}
	return Response.json({ ok: true, runId, busCreated: created });
}
