import { createHook, getWritable } from "workflow";

// An "announce" is any serializable object. __close is a sentinel that ends the bus run
// (used to exercise the cap-roll / completion path).
export type Announce = Record<string, unknown> & { __close?: boolean };

async function emit(payload: Announce) {
  "use step";
  const writer = getWritable<Announce>().getWriter();
  try {
    await writer.write(payload);
  } finally {
    writer.releaseLock();
  }
}

async function closeStream() {
  "use step";
  await getWritable().close();
}

// The per-identity bus: one run per token, holds a custom-token hook, re-emits every
// resumeHook payload onto its default out-stream. Subscribers tail that stream via
// getHookByToken(token).runId -> getRun(runId).getReadable().
export async function busWorkflow(busToken: string) {
  "use workflow";
  const hook = createHook<Announce>({ token: busToken });
  for await (const payload of hook) {
    if (payload && payload.__close) break;
    await emit(payload);
  }
  await closeStream();
  // workflow returns -> run completes -> hook auto-disposes -> token frees
}
