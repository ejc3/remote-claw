import type { Frame, FrameHeader } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import type { BrokerClient } from "../../../broker/client.js";
import { NOOP_TRACER } from "../../../trace.js";
import { type DriverCapabilities, MITM_CAPABILITIES, TMUX_HARNESS } from "../driver.js";
import { Session } from "../session.js";
import { bridgeSession, startBridgeSession } from "./bridge.js";

const ID = new Uint8Array(16);

class FakeClient {
  announces: Array<Record<string, unknown>> = [];
  streamStarts = 0;
  seqCursorCalls = 0;
  frameCountCursorCalls = 0;
  failAnnounces = 0;
  announceBlocks: Promise<void>[] = [];
  durable = false;
  frameCountError: Error | null = null;

  async seqCursor(): Promise<{ maxSeq: number | null; durable: boolean }> {
    this.seqCursorCalls += 1;
    return { maxSeq: null, durable: this.durable };
  }

  async frameCountCursor(): Promise<{ frameCount: number | null; durable: boolean }> {
    this.frameCountCursorCalls += 1;
    if (this.frameCountError !== null) throw this.frameCountError;
    return { frameCount: null, durable: this.durable };
  }

  async postMessage(): Promise<unknown[]> {
    return [{ ok: true }];
  }

  async postFrame(header: FrameHeader, body: Uint8Array): Promise<unknown> {
    if (header.recordKind === "session_announce") {
      const block = this.announceBlocks.shift();
      if (block !== undefined) await block;
      if (this.failAnnounces > 0) {
        this.failAnnounces -= 1;
        throw new Error("injected announce failure");
      }
      this.announces.push(JSON.parse(new TextDecoder().decode(body)));
    }
    return { ok: true };
  }

  async *streamFrames(opts: { signal?: AbortSignal }): AsyncGenerator<Frame> {
    this.streamStarts += 1;
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async openFrame(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await tick();
  if (!predicate()) throw new Error("timed out");
}

describe("bridge lifecycle", () => {
  it("refreshes one live bridge without restarting its pumps", async () => {
    const session = new Session("s", "session", {});
    const client = new FakeClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/old",
      git: null,
      signal: abort.signal,
      relays,
      tracer: NOOP_TRACER,
    });
    const readyCapabilities: DriverCapabilities = {
      structuredPermissions: false,
      status: true,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: false,
    };
    const git = { branch: "main", sha: "deadbeef", dirty: false, ahead: 0, behind: 0 };

    await waitFor(() => client.announces.length === 1 && client.streamStarts === 1);
    expect(relays.has(handle.served)).toBe(true);
    await handle.refresh({
      title: "ready",
      cwd: "/new",
      git,
      capabilities: readyCapabilities,
    });

    expect(client.streamStarts).toBe(1);
    expect(client.announces).toHaveLength(2);
    expect(client.announces.at(-1)).toMatchObject({
      title: "ready",
      cwd: "/new",
      git,
      capabilities: readyCapabilities,
      harness: TMUX_HARNESS,
    });

    client.failAnnounces = 1;
    const retainedCapabilities: DriverCapabilities = {
      structuredPermissions: true,
      status: false,
      controls: { interrupt: true, setModel: false, setMode: true, end: false },
      attachments: false,
    };
    await expect(
      handle.refresh({
        title: "missed",
        cwd: "/missed",
        git: null,
        capabilities: retainedCapabilities,
      }),
    ).rejects.toThrow("injected announce failure");

    // Advisory delivery failed, but the validated snapshot is still the relay's latest truth. A
    // presence change must re-announce that snapshot without requiring the owner to replay refresh().
    session.workerStatus = "running";
    session.wake();
    await waitFor(() => client.announces.length === 3);
    expect(client.announces.at(-1)).toMatchObject({
      title: "missed",
      cwd: "/missed",
      git: null,
      capabilities: retainedCapabilities,
      harness: TMUX_HARNESS,
      status: "running",
      phase: "thinking",
    });

    await handle.refresh({
      title: "recovered",
      cwd: "/recovered",
      git,
      capabilities: readyCapabilities,
    });
    expect(client.announces).toHaveLength(4);
    expect(client.announces.at(-1)?.title).toBe("recovered");
    expect(client.streamStarts).toBe(1);

    abort.abort();
    await handle.served;
    expect(relays.has(handle.served)).toBe(false);
  });

  it("captures a queued refresh snapshot when refresh is called", async () => {
    const session = new Session("queued", "session", {});
    const client = new FakeClient();
    let releaseInitial = () => {};
    client.announceBlocks.push(
      new Promise<void>((resolve) => {
        releaseInitial = resolve;
      }),
    );
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/old",
      git: null,
      signal: abort.signal,
      relays,
      tracer: NOOP_TRACER,
    });
    const capabilities: DriverCapabilities = {
      structuredPermissions: false,
      status: true,
      controls: { interrupt: true, setModel: false, setMode: false, end: false },
      attachments: true,
    };
    const git = { branch: "main", sha: "12345678", dirty: false, ahead: 0, behind: 0 };
    const announcement = {
      title: "captured",
      cwd: "/captured",
      git,
      capabilities,
    };

    const refreshing = handle.refresh(announcement);
    announcement.title = "mutated";
    announcement.cwd = "/mutated";
    git.branch = "mutated";
    capabilities.status = false;
    capabilities.controls.interrupt = false;
    releaseInitial();
    await refreshing;

    expect(client.announces).toHaveLength(2);
    expect(client.announces.at(-1)).toMatchObject({
      title: "captured",
      cwd: "/captured",
      git: { branch: "main" },
      capabilities: {
        status: true,
        controls: { interrupt: true },
      },
    });

    abort.abort();
    await handle.served;
  });

  it("keeps teardown pending for a delayed initial announce and drops queued refreshes on abort", async () => {
    const session = new Session("delayed", "session", {});
    const client = new FakeClient();
    let releaseInitial = () => {};
    client.announceBlocks.push(
      new Promise<void>((resolve) => {
        releaseInitial = resolve;
      }),
    );
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      tracer: NOOP_TRACER,
    });
    const refreshing = handle.refresh({
      title: "ready",
      cwd: "/repo",
      git: null,
      capabilities: MITM_CAPABILITIES,
    });

    await waitFor(() => client.streamStarts === 1);
    abort.abort();
    await expect(refreshing).rejects.toThrow("bridge is no longer serving");
    await expect(
      handle.refresh({
        title: "dead",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");

    let teardownFinished = false;
    void handle.served.then(() => {
      teardownFinished = true;
    });
    await tick();
    expect(teardownFinished).toBe(false);
    expect(relays.has(handle.served)).toBe(true);

    releaseInitial();
    await handle.served;
    expect(client.announces.map((announcement) => announcement.title)).toEqual(["starting"]);
    expect(relays.has(handle.served)).toBe(false);
  });

  it("rejects refresh after a fatal relay termination", async () => {
    const session = new Session("fatal", "session", {});
    const client = new FakeClient();
    client.durable = true;
    client.frameCountError = new Error("injected durable cursor failure");
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "starting",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      tracer: NOOP_TRACER,
    });

    await handle.served;
    expect(client.announces).toHaveLength(1);
    expect(client.streamStarts).toBe(0);
    expect(relays.has(handle.served)).toBe(false);
    await expect(
      handle.refresh({
        title: "dead",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");
    expect(client.announces).toHaveLength(1);
  });

  it("does not announce a bridge whose owner is already aborted", async () => {
    const session = new Session("already-stopped", "session", {});
    const client = new FakeClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();
    abort.abort();

    const handle = startBridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "ghost",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      tracer: NOOP_TRACER,
    });

    await handle.served;
    expect(client.announces).toHaveLength(0);
    expect(client.seqCursorCalls).toBe(0);
    expect(client.frameCountCursorCalls).toBe(0);
    expect(client.streamStarts).toBe(0);
    await expect(
      handle.refresh({
        title: "still dead",
        cwd: "/repo",
        git: null,
        capabilities: MITM_CAPABILITIES,
      }),
    ).rejects.toThrow("bridge is no longer serving");
  });

  it("keeps bridgeSession as the served-promise compatibility API", async () => {
    const session = new Session("legacy", "session", {});
    const client = new FakeClient();
    const relays = new Set<Promise<void>>();
    const abort = new AbortController();

    const served = bridgeSession({
      session,
      capabilities: MITM_CAPABILITIES,
      harness: TMUX_HARNESS,
      newClient: () => client as unknown as BrokerClient,
      identityId: ID,
      title: "legacy",
      cwd: "/repo",
      git: null,
      signal: abort.signal,
      relays,
      tracer: NOOP_TRACER,
    });

    expect(served).toBeInstanceOf(Promise);
    expect(relays.has(served)).toBe(true);
    abort.abort();
    await served;
    expect(relays.has(served)).toBe(false);
  });
});
