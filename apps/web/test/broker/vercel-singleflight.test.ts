// Regression guard for the VercelBackend ensureChannel SINGLEFLIGHT (the fix for the flaky real-rc
// cold-start timeout). A host announces + serves (+ heartbeats presence) near-simultaneously, so two
// publishers race to resolve-or-start the SAME token. Without singleflight both see no hook and both
// start() a relay run — one wins createHook, the loser dies with a HookConflictError, and on a cold
// runtime the wasted round can push the winner's registration past the caller's deadline (the stall).
// These tests pin: (1) concurrent first-publishes on one token => exactly ONE start(); (2) the
// in-flight entry clears on settle, so a later publish re-checks liveness and starts a fresh run if
// the prior one died (no stale-promise caching).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError, WorkflowWorldError } from "workflow/errors";

vi.mock("workflow/api", () => ({
  getHookByToken: vi.fn(),
  getRun: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
}));

import { getHookByToken, resumeHook, start } from "workflow/api";
import { PublishConflictError, type RelayPayload } from "../../lib/broker/backend";
import { VercelBackend } from "../../lib/broker/vercel";

const mockStart = vi.mocked(start);
const mockGetHook = vi.mocked(getHookByToken);
const mockResume = vi.mocked(resumeHook);

/** A payload that is NOT a __close sentinel — isClose() is false, so publish resolve-or-starts. */
const FRAME = {} as unknown as RelayPayload;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tokenBearingFailure(token: string): WorkflowWorldError & { url: string } {
  const url = `https://workflow.example/v2/hooks/by-token?token=${token}`;
  return Object.assign(new WorkflowWorldError(`hook lookup failed: ${url}`, { status: 503 }), {
    url,
  });
}

async function expectSanitizedLookupFailure(
  promise: Promise<unknown>,
  token: string,
  original: Error,
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBe(original);
  const sanitized = thrown as Error & { cause?: unknown; url?: unknown };
  expect(sanitized.message).toBe("workflow hook lookup failed for bus channel");
  expect(sanitized.message).not.toContain(token);
  expect(sanitized.url).toBeUndefined();
  expect(sanitized.cause).toBeUndefined();
}

describe("VercelBackend ensureChannel singleflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("collapses concurrent first-publishes on one token to a single start()", async () => {
    const gate = deferred<void>();
    let registered = false;
    // start() blocks on the gate, then registers the hook — this holds BOTH concurrent callers in the
    // resolve-or-start window at once, which is exactly when a double start() would occur.
    mockStart.mockImplementation(async () => {
      await gate.promise;
      registered = true;
      return undefined as never; // resolveOrStartChannel awaits start() but ignores its Run return
    });
    mockGetHook.mockImplementation(async () => {
      if (!registered) throw new HookNotFoundError("bus:deadbeefdeadbeefdeadbeefdeadbeef");
      return { runId: "run-1" } as never;
    });
    mockResume.mockResolvedValue(undefined as never);

    const backend = new VercelBackend();
    const p1 = backend.publish("bus:deadbeefdeadbeefdeadbeefdeadbeef", FRAME);
    const p2 = backend.publish("bus:deadbeefdeadbeefdeadbeefdeadbeef", FRAME);

    // Let both publishes reach ensureChannel (and dedup) before start settles.
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockStart).toHaveBeenCalledTimes(1); // one run, not two → no HookConflict, no wasted round
    expect(mockResume).toHaveBeenCalledTimes(2); // both frames still delivered
    expect(r1.channelId).toBe("run-1");
    expect(r2.channelId).toBe("run-1");
  });

  it("clears the in-flight entry on settle so a later publish re-checks liveness", async () => {
    let registered = false;
    mockStart.mockImplementation(async () => {
      registered = true;
      return undefined as never;
    });
    mockGetHook.mockImplementation(async () => {
      if (!registered) throw new HookNotFoundError("bus:cafecafecafecafecafecafecafecafe");
      return { runId: "run-1" } as never;
    });
    mockResume.mockResolvedValue(undefined as never);

    const backend = new VercelBackend();
    await backend.publish("bus:cafecafecafecafecafecafecafecafe", FRAME);
    expect(mockStart).toHaveBeenCalledTimes(1);

    // The run "dies": the next resolve fails until a FRESH start re-registers. If the singleflight
    // entry had been cached past settle, this publish would return the stale resolved promise and
    // never start() again — the assertion below would read 1.
    registered = false;
    await backend.publish("bus:cafecafecafecafecafecafecafecafe", FRAME);
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it("clears the entry after a REJECTED resolve-or-start (a failed start never poisons the token)", async () => {
    // Guards the "clears on settle (success OR FAILURE)" contract specifically for the failure path —
    // the reason we use `.finally` (not `.then`). If cleanup were success-only, the first publish's
    // REJECTED promise would stay cached: the retry below would re-await that same rejection and
    // never start() again (mockStart stuck at 1, the publish rejecting) — this test would fail.
    const token = "bus:beadbeadbeadbeadbeadbeadbeadbead";
    const startFailure = tokenBearingFailure(token);
    let registered = false;
    let startShouldFail = true;
    mockStart.mockImplementation(async () => {
      if (startShouldFail) throw startFailure;
      registered = true;
      return undefined as never;
    });
    mockGetHook.mockImplementation(async () => {
      if (!registered) throw new HookNotFoundError(token);
      return { runId: "run-1" } as never;
    });
    mockResume.mockResolvedValue(undefined as never);

    const backend = new VercelBackend();
    // 1st publish: no hook → start() throws → publish rejects. The `.finally` must still clear the entry.
    const firstPublish = backend.publish(token, FRAME);
    await expect(firstPublish).rejects.not.toBe(startFailure);
    await expect(firstPublish).rejects.toThrow("workflow channel start failed for bus channel");
    await expect(firstPublish).rejects.not.toThrow(token);
    expect(mockStart).toHaveBeenCalledTimes(1);

    // 2nd publish: the entry cleared → a fresh resolve-or-start → start() again (now succeeds) → run-1.
    startShouldFail = false;
    const r = await backend.publish(token, FRAME);
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(r.channelId).toBe("run-1");
  });
});

describe("VercelBackend hook lookup error classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts a missing channel only for Workflow's typed hook absence", async () => {
    const token = "bus:11111111111111111111111111111111";
    mockGetHook
      .mockRejectedValueOnce(new HookNotFoundError(token))
      .mockResolvedValueOnce({ runId: "run-created" } as never);
    mockStart.mockResolvedValue(undefined as never);
    mockResume.mockResolvedValue(undefined as never);

    await expect(new VercelBackend().publish(token, FRAME)).resolves.toEqual({
      created: true,
      channelId: "run-created",
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("hard-fails but sanitizes a failed initial lookup without starting a replacement run", async () => {
    const token = "bus:22222222222222222222222222222222";
    const failure = tokenBearingFailure(token);
    mockGetHook.mockRejectedValue(failure);

    await expectSanitizedLookupFailure(new VercelBackend().publish(token, FRAME), token, failure);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("sanitizes a failed registration poll instead of retrying it as absence", async () => {
    const token = "bus:33333333333333333333333333333333";
    const failure = tokenBearingFailure(token);
    mockGetHook.mockRejectedValueOnce(new HookNotFoundError(token)).mockRejectedValueOnce(failure);
    mockStart.mockResolvedValue(undefined as never);

    await expectSanitizedLookupFailure(new VercelBackend().publish(token, FRAME), token, failure);
    expect(mockGetHook).toHaveBeenCalledTimes(2);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("treats a typed missing-hook close as a no-op but propagates lookup outages", async () => {
    const absentToken = "bus:44444444444444444444444444444444";
    mockGetHook.mockRejectedValueOnce(new HookNotFoundError(absentToken));

    await expect(new VercelBackend().publish(absentToken, { __close: true })).resolves.toEqual({
      created: false,
      channelId: "",
    });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();

    const outageToken = "bus:55555555555555555555555555555555";
    const failure = tokenBearingFailure(outageToken);
    mockGetHook.mockRejectedValueOnce(failure);
    await expectSanitizedLookupFailure(
      new VercelBackend().publish(outageToken, { __close: true }),
      outageToken,
      failure,
    );
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("returns null only for typed absence when subscribing and propagates lookup outages", async () => {
    const absentToken = "bus:66666666666666666666666666666666";
    mockGetHook.mockRejectedValueOnce(new HookNotFoundError(absentToken));

    await expect(new VercelBackend().subscribe(absentToken, 0)).resolves.toBeNull();

    const outageToken = "bus:77777777777777777777777777777777";
    const failure = tokenBearingFailure(outageToken);
    mockGetHook.mockRejectedValueOnce(failure);
    await expectSanitizedLookupFailure(
      new VercelBackend().subscribe(outageToken, 0),
      outageToken,
      failure,
    );
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("hard-fails but sanitizes a malformed successful hook lookup instead of treating it as absence", async () => {
    const token = "bus:88888888888888888888888888888888";
    mockGetHook.mockResolvedValue({} as never);

    const publish = new VercelBackend().publish(token, FRAME);
    await expect(publish).rejects.toThrow("workflow hook lookup failed for bus channel");
    await expect(publish).rejects.not.toThrow(token);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });
});

describe("VercelBackend resumeHook error classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHook.mockResolvedValue({ runId: "run-live" } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("classifies Workflow's typed vanished-hook race as a retryable publish conflict", async () => {
    const token = "bus:facefacefacefacefacefacefaceface";
    mockResume.mockRejectedValue(new HookNotFoundError(token));

    const publish = new VercelBackend().publish(token, FRAME);

    await expect(publish).rejects.toBeInstanceOf(PublishConflictError);
    await expect(publish).rejects.toThrow("workflow channel disappeared during publish");
    await expect(publish).rejects.not.toThrow(token);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("hard-fails and sanitizes an unrelated resume failure", async () => {
    const token = "bus:feedfeedfeedfeedfeedfeedfeedfeed";
    const failure = tokenBearingFailure(token);
    mockResume.mockRejectedValue(failure);

    const publish = new VercelBackend().publish(token, FRAME);

    await expect(publish).rejects.not.toBe(failure);
    await expect(publish).rejects.toThrow("workflow channel delivery failed for bus channel");
    await expect(publish).rejects.not.toThrow(token);
    expect(PublishConflictError.is(failure)).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockResume).toHaveBeenCalledTimes(1);
  });
});
