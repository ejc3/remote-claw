import { createHook, getWritable } from "workflow";
import { HookConflictError } from "@workflow/errors";

async function report(result: Record<string, unknown>) {
  "use step";
  const writer = getWritable().getWriter();
  try {
    await writer.write(result);
  } finally {
    writer.releaseLock();
  }
  await getWritable().close();
}

// Tries to createHook on a token that another live run already holds. Per the SDK docs,
// awaiting the hook should throw HookConflictError. We catch it and report the outcome on
// this probe run's own out-stream so the API route can read the verdict.
export async function conflictProbeWorkflow(busToken: string) {
  "use workflow";
  try {
    const hook = createHook<Record<string, unknown>>({ token: busToken });
    await hook; // expected to throw HookConflictError if the token is held
    await report({
      conflict: false,
      note: "hook resolved WITHOUT conflict (unexpected when the token was already held)",
    });
  } catch (e: unknown) {
    const err = e as { name?: string; token?: string; message?: string };
    await report({
      conflict: HookConflictError.is(e),
      name: err?.name,
      token: err?.token,
      message: String(err?.message ?? "").slice(0, 200),
    });
  }
}
