import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  RuntimeOwnerDaemon,
  type RuntimeOwnerDaemonService,
  readLinuxRuntimeOwnerProcessStartIdentity,
} from "./daemon.js";
import { RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID } from "./service.js";

const MACHINE_IDENTITY = "0123456789abcdef0123456789abcdef";
const BOOT_ID = "12345678-1234-1234-1234-123456789abc";

function procStat(pid: number, startTimeTicks: number): string {
  const fields = ["S", ...Array.from({ length: 18 }, () => "0"), String(startTimeTicks)];
  return `${pid} (remote ) claw test) ${fields.join(" ")}\n`;
}

function processIdentity(
  overrides: Readonly<{
    machineIdentityId?: string;
    bootId?: string;
    pid?: number;
    start?: number;
  }> = {},
) {
  const machineIdentityId = overrides.machineIdentityId ?? MACHINE_IDENTITY;
  const bootId = overrides.bootId ?? BOOT_ID;
  const pid = overrides.pid ?? 4321;
  const start = overrides.start ?? 987_654;
  return readLinuxRuntimeOwnerProcessStartIdentity(machineIdentityId, {
    pid,
    readTextFile: (path) => (path.endsWith("boot_id") ? `${bootId}\n` : procStat(pid, start)),
  });
}

class FakeDaemonService implements RuntimeOwnerDaemonService {
  readonly completed: Promise<void>;
  stopCalls = 0;
  readonly #resolve: () => void;

  constructor() {
    let resolveCompletion: (() => void) | undefined;
    this.completed = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    if (resolveCompletion === undefined) throw new Error("completion setup failed");
    this.#resolve = resolveCompletion;
  }

  stop(): Promise<void> {
    this.stopCalls++;
    this.#resolve();
    return this.completed;
  }

  poison(): void {
    this.#resolve();
  }
}

describe("runtime-owner daemon", () => {
  it("binds the owner identity to schema, machine, boot, pid, and process start ticks", () => {
    const baseline = processIdentity();

    expect(baseline).toMatchObject({
      schemaId: RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID,
      machineIdentityId: MACHINE_IDENTITY,
      bootId: BOOT_ID,
      pid: 4321,
      processStartTimeTicks: 987_654,
    });
    expect(baseline.ownerInstanceId).toBe(`roi_${baseline.canonicalDigest}`);
    expect(baseline.ownerStartIdentityRef).toBe(baseline.ownerInstanceId);
    expect(
      processIdentity({ machineIdentityId: "1123456789abcdef0123456789abcdef" }),
    ).not.toMatchObject({ canonicalDigest: baseline.canonicalDigest });
    expect(processIdentity({ bootId: "22345678-1234-1234-1234-123456789abc" })).not.toMatchObject({
      canonicalDigest: baseline.canonicalDigest,
    });
    expect(processIdentity({ pid: 4322 })).not.toMatchObject({
      canonicalDigest: baseline.canonicalDigest,
    });
    expect(processIdentity({ start: 987_655 })).not.toMatchObject({
      canonicalDigest: baseline.canonicalDigest,
    });
  });

  it("rejects malformed proc evidence and never falls back to PID alone", () => {
    expect(() =>
      readLinuxRuntimeOwnerProcessStartIdentity(MACHINE_IDENTITY, {
        pid: 4321,
        readTextFile: (path) =>
          path.endsWith("boot_id") ? `${BOOT_ID}\n` : "4321 (remote-claw) S 0 0\n",
      }),
    ).toThrow();
    expect(() =>
      readLinuxRuntimeOwnerProcessStartIdentity(MACHINE_IDENTITY, {
        pid: 4321,
        readTextFile: (path) =>
          path.endsWith("boot_id") ? `${BOOT_ID}\n` : procStat(9999, 987_654),
      }),
    ).toThrow();
  });

  it.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("gracefully stops once on %s and removes both signal listeners", async (signal) => {
    const signalTarget = new EventEmitter();
    const service = new FakeDaemonService();
    const daemon = new RuntimeOwnerDaemon(service, signalTarget);

    signalTarget.emit(signal);
    await daemon.completed;
    signalTarget.emit(signal);

    expect(service.stopCalls).toBe(1);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(service.stopCalls).toBe(1);
  });

  it("completes and removes signal listeners when the service poisons without a signal", async () => {
    const signalTarget = new EventEmitter();
    const service = new FakeDaemonService();
    const daemon = new RuntimeOwnerDaemon(service, signalTarget);

    service.poison();
    await daemon.completed;

    expect(service.stopCalls).toBe(0);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });
});
