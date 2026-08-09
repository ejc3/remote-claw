import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { base64urlEncode, deriveIdentity, toHex } from "@remote-claw/clawsec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeRuntimeId } from "../state/digests.js";
import {
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseEd25519PublicKey,
  parseWardenLaunchNonce,
} from "../state/ids.js";
import type {
  AcquireRuntimeOwnerServiceLeaseRequest,
  RuntimeOwnerOperationEvidence,
  RuntimeOwnerServiceFence,
} from "../state/runtime-repository.js";
import { openHostStateDatabase } from "../state/sqlite.js";
import {
  HOST_STATE_TEST_FILESYSTEM_SUPPORTED,
  HOST_STATE_TEST_TEMPORARY_DIRECTORY,
} from "../state/test-environment.js";
import { bootstrapRuntimeOwner } from "./bootstrap.js";
import { connectRuntimeOwnerRpc } from "./client.js";
import { generateWrappedRuntimeOwnerIdentityKey } from "./key-custody.js";
import {
  createRuntimeOwnerDetachedSpawner,
  RUNTIME_OWNER_DEFAULT_SPAWN_SETTLE_TIMEOUT_MS,
  sanitizedRuntimeOwnerDaemonEnvironment,
  sanitizedRuntimeOwnerExecutableArgv,
  startProductionRuntimeOwnerDaemon,
} from "./production.js";
import { RuntimeOwnerRpcError } from "./protocol.js";
import type { NativeRegistrationAdapter } from "./registration-service.js";

const linuxWithUid = process.platform === "linux" && typeof process.getuid === "function";
const describeLinux = describe.runIf(linuxWithUid && HOST_STATE_TEST_FILESYSTEM_SUPPORTED);
const temporaryRoots: string[] = [];

function digest(fill: number) {
  return parseA1Digest(base64urlEncode(new Uint8Array(32).fill(fill)));
}

function operation(label: string, fill: number): RuntimeOwnerOperationEvidence {
  return {
    operationId: parseA1SafeId(`${label}-${fill}`),
    operationSchemaId: `remote-claw/test/${label}/v1`,
    operationDigest: digest(fill),
  };
}

async function machineIdentityId(secret: Uint8Array): Promise<string> {
  const identity = await deriveIdentity(secret);
  try {
    return toHex(identity.identityId);
  } finally {
    identity.authToken.fill(0);
    identity.identityId.fill(0);
    identity.contentRoot.fill(0);
    identity.controlKey.fill(0);
    identity.kMeta.fill(0);
  }
}

function stateFor(machineIdentityId: string) {
  const root = mkdtempSync(
    join(HOST_STATE_TEST_TEMPORARY_DIRECTORY, "remote-claw-a13-production-"),
  );
  temporaryRoots.push(root);
  const environment = {
    xdgStateHome: join(root, "state"),
    homeDirectory: join(root, "home"),
  };
  const database = openHostStateDatabase({ machineIdentityId, pathEnvironment: environment });
  database.close();
  vi.stubEnv("XDG_STATE_HOME", environment.xdgStateHome);
  return environment;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime-owner detached process boundary", () => {
  it("copies only state/home/temp variables into the daemon", () => {
    expect(
      sanitizedRuntimeOwnerDaemonEnvironment({
        HOME: "/home/operator",
        XDG_STATE_HOME: "/state/operator",
        TMPDIR: "/safe/tmp",
        PATH: "/unneeded/bin",
        NODE_OPTIONS: "--inspect=0.0.0.0:9229",
        ANTHROPIC_API_KEY: "anthropic-secret",
        OPENAI_API_KEY: "openai-secret",
        REMOTE_CLAW_SECRET_FILE: "/private/secret",
      }),
    ).toEqual({
      HOME: "/home/operator",
      TMPDIR: "/safe/tmp",
      XDG_STATE_HOME: "/state/operator",
    });
  });

  it("drops inspector, eval, test, env-file, and arbitrary loader exec flags", () => {
    const preflight = "/workspace/node_modules/tsx/dist/preflight.cjs";
    const loader = "file:///workspace/node_modules/tsx/dist/loader.mjs";
    expect(
      sanitizedRuntimeOwnerExecutableArgv(
        [
          "--inspect=0.0.0.0:9229",
          "--eval",
          "stealSecrets()",
          "--test",
          "--watch",
          "--env-file=/private/.env",
          "--require",
          "/tmp/arbitrary.cjs",
          "--import",
          "data:text/javascript,stealSecrets()",
          "--require",
          preflight,
          "--import",
          loader,
        ],
        true,
      ),
    ).toEqual(["--require", preflight, "--import", loader]);
    expect(sanitizedRuntimeOwnerExecutableArgv(["--require", preflight], false)).toEqual([]);
  });

  it("spawns by absolute executable and secret path without forwarding credentials", async () => {
    const child = new EventEmitter() as EventEmitter & {
      unref: ReturnType<typeof vi.fn>;
    };
    child.unref = vi.fn();
    let captured:
      | {
          executable: string;
          argv: readonly string[];
          options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv; cwd: string };
        }
      | undefined;
    const spawn = createRuntimeOwnerDetachedSpawner({
      secretFilePath: "/state/remote-claw/secret",
      executablePath: "/usr/bin/node",
      executableArgv: ["--inspect=9229", "--eval", "provider-token-super-secret"],
      environment: {
        HOME: "/home/operator",
        PATH: "/unneeded/bin",
        OPENAI_API_KEY: "provider-token-super-secret",
        NODE_OPTIONS: "--inspect=9229",
      },
      productionModuleUrl: "file:///opt/remote-claw/src/host/runtime-owner/production.ts",
      spawnProcess: ((
        executable: string,
        argv: readonly string[],
        options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv; cwd: string },
      ) => {
        captured = { executable, argv, options };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as never,
    });

    await spawn({ machineIdentityId: "55".repeat(16), detached: true });

    expect(captured).toEqual({
      executable: "/usr/bin/node",
      argv: [
        "/opt/remote-claw/src/runtime-owner-cli.ts",
        "--machine-identity",
        "55".repeat(16),
        "--secret-file",
        "/state/remote-claw/secret",
      ],
      options: {
        detached: true,
        stdio: "ignore",
        env: { HOME: "/home/operator" },
        cwd: "/opt/remote-claw/src",
      },
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(JSON.stringify(captured)).not.toContain("provider-token-super-secret");
    expect(JSON.stringify(captured)).not.toContain("--inspect");
  });

  it("bounds spawn settlement, cleans up, and preserves fail-soft bootstrap", async () => {
    vi.useFakeTimers();
    expect(RUNTIME_OWNER_DEFAULT_SPAWN_SETTLE_TIMEOUT_MS).toBe(5_000);
    for (const spawnSettleTimeoutMs of [0, 60_001]) {
      expect(() =>
        createRuntimeOwnerDetachedSpawner({
          secretFilePath: "/state/remote-claw/secret",
          spawnSettleTimeoutMs,
        }),
      ).toThrow(TypeError);
    }

    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.kill = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    child.unref = vi.fn();
    const spawnDetached = createRuntimeOwnerDetachedSpawner({
      secretFilePath: "/state/remote-claw/secret",
      executablePath: "/usr/bin/node",
      executableArgv: [],
      productionModuleUrl: "file:///opt/remote-claw/src/host/runtime-owner/production.js",
      spawnProcess: (() => child) as never,
    });
    const result = bootstrapRuntimeOwner({
      machineIdentityId: "66".repeat(16),
      identitySecret: new Uint8Array(32).fill(6),
      spawnDetached,
      connect: async () => {
        throw new RuntimeOwnerRpcError("UNAVAILABLE");
      },
    });
    const outcome = expect(result).resolves.toEqual({
      status: "unavailable",
      client: null,
      spawnAttempted: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(child.listenerCount("spawn")).toBe(1);
    await vi.advanceTimersByTimeAsync(RUNTIME_OWNER_DEFAULT_SPAWN_SETTLE_TIMEOUT_MS);
    await outcome;

    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.listenerCount("spawn")).toBe(1);
    expect(() => child.emit("spawn")).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(1);
    expect(() => child.emit("error", new Error("late child failure"))).not.toThrow();
    expect(child.listenerCount("error")).toBe(0);
  });
});

describeLinux("runtime-owner production state adapter", () => {
  it("enables registration only with a trusted adapter and releases its coordinator before shutdown", async () => {
    const identitySecret = new Uint8Array(32).fill(0x7a);
    const machineIdentity = await machineIdentityId(identitySecret);
    const environment = stateFor(machineIdentity);
    const unused = (): never => {
      throw new Error("adapter should not be invoked by health");
    };
    const adapter: NativeRegistrationAdapter = {
      measureOpen: unused,
      measureBinding: unused,
      measurePublication: unused,
      measureReattach: unused,
    };
    const daemon = await startProductionRuntimeOwnerDaemon({
      machineIdentityId: machineIdentity,
      identitySecret,
      registrationAdapter: adapter,
    });
    const client = await connectRuntimeOwnerRpc({
      machineIdentityId: machineIdentity,
      identitySecret,
    });
    expect(await client.health()).toMatchObject({
      ownerOperationsWritable: true,
      nativeRegistrationEnabled: true,
    });
    client.close();

    const during = openHostStateDatabase({
      machineIdentityId: machineIdentity,
      pathEnvironment: environment,
    });
    const current = during.records.readDefaultCollaborationServer();
    expect(current?.server.currentCoordinatorLeaseId).not.toBeNull();
    const coordinatorLeaseId = current?.server.currentCoordinatorLeaseId;
    const serverId = current?.server.collaborationServerId;
    during.close();
    if (coordinatorLeaseId === null || coordinatorLeaseId === undefined || serverId === undefined) {
      throw new Error("coordinator fixture is absent");
    }

    await daemon.stop();
    await daemon.completed;
    const after = openHostStateDatabase({
      machineIdentityId: machineIdentity,
      pathEnvironment: environment,
    });
    try {
      expect(
        after.records.readDefaultCollaborationServer()?.server.currentCoordinatorLeaseId,
      ).toBeNull();
      expect(after.records.readCoordinatorLease(serverId, coordinatorLeaseId)).toMatchObject({
        state: "released",
      });
    } finally {
      after.close();
    }
  });

  it("reopens and reconciles a coordinator acquisition whose COMMIT acknowledgement is lost", async () => {
    const identitySecret = new Uint8Array(32).fill(0x7b);
    const machineIdentity = await machineIdentityId(identitySecret);
    const environment = stateFor(machineIdentity);
    const unused = (): never => {
      throw new Error("adapter should not be invoked by coordinator startup");
    };
    const adapter: NativeRegistrationAdapter = {
      measureOpen: unused,
      measureBinding: unused,
      measurePublication: unused,
      measureReattach: unused,
    };
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    let simulated = false;
    let applicationCommits = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (armed && sql === "COMMIT") {
        applicationCommits += 1;
        if (applicationCommits === 2 && !simulated) {
          Reflect.apply(originalExec, this, [sql]);
          simulated = true;
          armed = false;
          throw new Error("simulated lost coordinator COMMIT acknowledgement");
        }
      }
      Reflect.apply(originalExec, this, [sql]);
    });

    const daemon = await startProductionRuntimeOwnerDaemon({
      machineIdentityId: machineIdentity,
      identitySecret,
      registrationAdapter: adapter,
    });
    armed = false;
    expect(simulated).toBe(true);
    const database = openHostStateDatabase({
      machineIdentityId: machineIdentity,
      pathEnvironment: environment,
    });
    try {
      expect(database.records.readDefaultCollaborationServer()?.server).toMatchObject({
        currentCoordinatorEpoch: 1,
      });
      expect(
        database.records.readDefaultCollaborationServer()?.server.currentCoordinatorLeaseId,
      ).not.toBeNull();
    } finally {
      database.close();
    }
    await daemon.stop();
    await daemon.completed;
  });

  it("rejects a root secret that does not derive the requested machine namespace", async () => {
    await expect(
      startProductionRuntimeOwnerDaemon({
        machineIdentityId: "00".repeat(16),
        identitySecret: new Uint8Array(32).fill(0x70),
      }),
    ).rejects.toThrow(/reconciled/);
  });

  it("allows one of two racing daemons to own a fresh machine and keeps the other fenced", async () => {
    const identitySecret = new Uint8Array(32).fill(0x71);
    const machineIdentity = await machineIdentityId(identitySecret);
    stateFor(machineIdentity);
    const attempts = await Promise.allSettled([
      startProductionRuntimeOwnerDaemon({ machineIdentityId: machineIdentity, identitySecret }),
      startProductionRuntimeOwnerDaemon({ machineIdentityId: machineIdentity, identitySecret }),
    ]);
    const winners = attempts.filter(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof startProductionRuntimeOwnerDaemon>>
      > => attempt.status === "fulfilled",
    );
    const losers = attempts.filter((attempt) => attempt.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    await winners[0]?.value.stop();
    await winners[0]?.value.completed;
  });

  it("reopens and reconciles an acquisition whose COMMIT landed before reporting failure", async () => {
    const identitySecret = new Uint8Array(32).fill(0x72);
    const machineIdentity = await machineIdentityId(identitySecret);
    stateFor(machineIdentity);
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    let simulated = false;
    let applicationCommits = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (armed && sql === "COMMIT") {
        applicationCommits += 1;
        if (applicationCommits === 2 && !simulated) {
          Reflect.apply(originalExec, this, [sql]);
          simulated = true;
          armed = false;
          throw new Error("simulated lost COMMIT acknowledgement");
        }
      }
      Reflect.apply(originalExec, this, [sql]);
    });

    const daemon = await startProductionRuntimeOwnerDaemon({
      machineIdentityId: machineIdentity,
      identitySecret,
    });
    armed = false;

    expect(simulated).toBe(true);
    expect(daemon.service.lease.runtimeOwnerServiceEpoch).toBe(1);
    await daemon.stop();
    await daemon.completed;
  });

  it("does not retry an acquisition when reopened state proves the unknown COMMIT did not land", async () => {
    const identitySecret = new Uint8Array(32).fill(0x73);
    const machineIdentity = await machineIdentityId(identitySecret);
    const environment = stateFor(machineIdentity);
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    let simulated = false;
    let rollbackSimulated = false;
    let applicationCommits = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (armed && sql === "COMMIT") {
        applicationCommits += 1;
        if (applicationCommits === 2 && !simulated) {
          simulated = true;
          throw new Error("simulated uncommitted unknown outcome");
        }
      }
      if (armed && simulated && !rollbackSimulated && sql === "ROLLBACK") {
        rollbackSimulated = true;
        Reflect.apply(originalExec, this, [sql]);
        armed = false;
        throw new Error("simulated lost rollback acknowledgement");
      }
      Reflect.apply(originalExec, this, [sql]);
    });

    await expect(
      startProductionRuntimeOwnerDaemon({
        machineIdentityId: machineIdentity,
        identitySecret,
      }),
    ).rejects.toThrow(/unavailable/);
    armed = false;
    expect(simulated).toBe(true);

    const database = openHostStateDatabase({
      machineIdentityId: machineIdentity,
      pathEnvironment: environment,
    });
    const inventory = database.runtimeOwner.readInventory();
    expect(inventory.state.currentRuntimeOwnerServiceEpoch).toBe(0);
    expect(inventory.state.currentRuntimeOwnerServiceLeaseId).toBeNull();
    expect(inventory.serviceLeases).toEqual([]);
    expect(inventory.journal).toEqual([]);
    database.close();
  });

  it("reopens and reconciles a heartbeat whose COMMIT landed before reporting failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const identitySecret = new Uint8Array(32).fill(0x75);
    const machineIdentity = await machineIdentityId(identitySecret);
    stateFor(machineIdentity);
    const daemon = await startProductionRuntimeOwnerDaemon({
      machineIdentityId: machineIdentity,
      identitySecret,
    });
    const initialDeadline = daemon.service.lease.heartbeatDeadlineMs;
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    let simulated = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (armed && sql === "COMMIT" && !simulated) {
        Reflect.apply(originalExec, this, [sql]);
        simulated = true;
        armed = false;
        throw new Error("simulated lost heartbeat COMMIT acknowledgement");
      }
      Reflect.apply(originalExec, this, [sql]);
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(simulated).toBe(true);
    expect(daemon.service.state).toBe("running");
    expect(daemon.service.lease.heartbeatDeadlineMs).toBeGreaterThan(initialDeadline);
    await daemon.stop();
    await daemon.completed;
  });

  it("reopens and reconciles a release whose COMMIT landed before reporting failure", async () => {
    const identitySecret = new Uint8Array(32).fill(0x76);
    const machineIdentity = await machineIdentityId(identitySecret);
    const environment = stateFor(machineIdentity);
    const daemon = await startProductionRuntimeOwnerDaemon({
      machineIdentityId: machineIdentity,
      identitySecret,
    });
    const leaseId = daemon.service.lease.runtimeOwnerServiceLeaseId;
    const originalExec = DatabaseSync.prototype.exec;
    let armed = true;
    let simulated = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (armed && sql === "COMMIT" && !simulated) {
        Reflect.apply(originalExec, this, [sql]);
        simulated = true;
        armed = false;
        throw new Error("simulated lost release COMMIT acknowledgement");
      }
      Reflect.apply(originalExec, this, [sql]);
    });

    await daemon.stop();
    await daemon.completed;

    expect(simulated).toBe(true);
    const database = openHostStateDatabase({
      machineIdentityId: machineIdentity,
      pathEnvironment: environment,
    });
    try {
      const inventory = database.runtimeOwner.readInventory();
      expect(inventory.state.currentRuntimeOwnerServiceLeaseId).toBeNull();
      expect(inventory.serviceLeases).toEqual([
        expect.objectContaining({ runtimeOwnerServiceLeaseId: leaseId, state: "released" }),
      ]);
      expect(
        inventory.journal.filter(
          (entry) => entry.entryKind === "service_lease_released" && entry.subjectId === leaseId,
        ),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("refuses wrapped runtime keys that do not belong to this machine root secret", async () => {
    const identitySecret = new Uint8Array(32).fill(0x74);
    const machineIdentity = await machineIdentityId(identitySecret);
    const environment = stateFor(machineIdentity);
    const database = openHostStateDatabase({
      machineIdentityId: machineIdentity,
      pathEnvironment: environment,
    });
    const owner: AcquireRuntimeOwnerServiceLeaseRequest = {
      candidateLeaseId: parseA1SafeId("preparation-owner-lease"),
      ownerInstanceId: parseA1SafeId("preparation-owner-instance"),
      ownerProcessStartIdentitySchemaId: "remote-claw/test/process-start/v1",
      ownerProcessStartIdentityRef: parseA1SafeId("preparation-owner-process"),
      ownerProcessStartIdentityDigest: digest(20),
      expectedCurrentLeaseId: null,
      expectedRuntimeOwnerServiceEpoch: 0,
      leaseDurationMs: 600_000,
      operation: operation("prepare-acquire", 21),
    };
    database.runtimeOwner.acquireServiceLease(owner);
    const fence: RuntimeOwnerServiceFence = {
      runtimeOwnerServiceLeaseId: owner.candidateLeaseId,
      runtimeOwnerServiceEpoch: 1,
      ownerInstanceId: owner.ownerInstanceId,
      ownerProcessStartIdentitySchemaId: owner.ownerProcessStartIdentitySchemaId,
      ownerProcessStartIdentityRef: owner.ownerProcessStartIdentityRef,
      ownerProcessStartIdentityDigest: owner.ownerProcessStartIdentityDigest,
    };
    const wardenLaunchNonce = parseWardenLaunchNonce(base64urlEncode(new Uint8Array(32).fill(22)));
    const startIdentitySchemaId = "remote-claw/test/native-start/v1";
    const startIdentityDigest = digest(23);
    const runtimeId = await nativeRuntimeId({
      wardenLaunchNonce,
      startIdentitySchemaId,
      startIdentityDigest,
    });
    const wrapped = generateWrappedRuntimeOwnerIdentityKey(
      new Uint8Array(32).fill(0xff),
      runtimeId,
      1,
    );
    database.runtimeOwner.registerInitialRuntime({
      fence,
      operation: operation("runtime-register", 24),
      runtimeId,
      descriptor: { product: "codex", access: "app-server" },
      wardenLaunchNonce,
      startIdentitySchemaId,
      startIdentityRef: parseA1SafeId("prepared-native-start"),
      startIdentityDigest,
      runtimeOwnerAssignmentId: parseA1SafeId("prepared-runtime-assignment"),
      key: {
        runtimeOwnerIdentityKeyId: wrapped.binding.runtimeOwnerIdentityKeyId,
        publicKey: parseEd25519PublicKey(wrapped.binding.publicKey),
        signingKeyRef: {
          protectedHandleId: parseA1CanonicalId(
            "protectedHandle",
            `rcph_${base64urlEncode(new Uint8Array(16).fill(25))}`,
          ),
          kind: "signing_key",
        },
        localTrustEvidenceRef: parseA1SafeId("prepared-local-trust"),
        localTrustEvidenceDigest: digest(26),
        wrapNonce: wrapped.wrapNonce,
        wrappedPkcs8: wrapped.wrappedPkcs8,
        authTag: wrapped.authTag,
        pkcs8Digest: wrapped.pkcs8Digest,
      },
    });
    database.runtimeOwner.releaseServiceLease({
      fence,
      operation: operation("prepare-release", 27),
    });
    database.close();

    await expect(
      startProductionRuntimeOwnerDaemon({
        machineIdentityId: machineIdentity,
        identitySecret,
      }),
    ).rejects.toThrow(/unavailable/);
  });
});
