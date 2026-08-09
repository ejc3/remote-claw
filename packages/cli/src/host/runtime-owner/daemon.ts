import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import {
  RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID,
  type RuntimeOwnerHostStateDatabase,
  type RuntimeOwnerProcessStartIdentity,
  type RuntimeOwnerService,
  type StartRuntimeOwnerServiceOptions,
  startRuntimeOwnerService,
} from "./service.js";

const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RuntimeOwnerProcessIdentityDependencies {
  readonly pid?: number;
  readonly readTextFile?: (path: string) => string;
}

export interface RuntimeOwnerDaemonSignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface RuntimeOwnerDaemonService {
  readonly completed: Promise<void>;
  stop(): Promise<void>;
}

export interface StartRuntimeOwnerDaemonOptions<
  Database extends RuntimeOwnerHostStateDatabase = RuntimeOwnerHostStateDatabase,
> {
  readonly service: Omit<StartRuntimeOwnerServiceOptions<Database>, "ownerIdentity">;
  readonly signalTarget?: RuntimeOwnerDaemonSignalTarget;
  readonly processIdentityDependencies?: RuntimeOwnerProcessIdentityDependencies;
  readonly startService?: (
    options: StartRuntimeOwnerServiceOptions<Database>,
  ) => Promise<RuntimeOwnerService<Database>>;
}

function positiveSafeInteger(text: string, field: string): number {
  if (!/^[0-9]+$/.test(text)) throw new Error(`${field} is invalid`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} is invalid`);
  return value;
}

/**
 * Linux process identity is boot-scoped and start-time-scoped. A PID by itself is never an owner
 * identity because it can be reused after a crash.
 */
export function readLinuxRuntimeOwnerProcessStartIdentity(
  machineIdentityId: string,
  dependencies: RuntimeOwnerProcessIdentityDependencies = {},
): RuntimeOwnerProcessStartIdentity {
  if (process.platform !== "linux" || !MACHINE_IDENTITY.test(machineIdentityId)) {
    throw new Error("runtime owner process identity is unavailable");
  }
  const pid = dependencies.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("runtime owner process identity is unavailable");
  }
  const readTextFile = dependencies.readTextFile ?? ((path) => readFileSync(path, "utf8"));
  const bootId = readTextFile("/proc/sys/kernel/random/boot_id").trim();
  if (!BOOT_ID.test(bootId)) throw new Error("runtime owner process identity is unavailable");
  const stat = readTextFile("/proc/self/stat").trim();
  const delimiter = stat.lastIndexOf(") ");
  if (delimiter < 0 || !stat.startsWith(`${pid} (`)) {
    throw new Error("runtime owner process identity is unavailable");
  }
  const fieldsAfterComm = stat.slice(delimiter + 2).split(/\s+/);
  const startTimeText = fieldsAfterComm[19];
  if (startTimeText === undefined) throw new Error("runtime owner process identity is unavailable");
  const processStartTimeTicks = positiveSafeInteger(startTimeText, "process start time");

  const writer = new CanonicalWriter();
  writer.str(RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID);
  writer.str(machineIdentityId);
  writer.str(bootId);
  writer.uint(pid);
  writer.uint(processStartTimeTicks);
  const canonicalDigest = base64urlEncode(createHash("sha256").update(writer.finish()).digest());
  return Object.freeze({
    schemaId: RUNTIME_OWNER_LINUX_PROCESS_START_IDENTITY_SCHEMA_ID,
    machineIdentityId,
    bootId,
    pid,
    processStartTimeTicks,
    canonicalDigest,
    ownerInstanceId: `roi_${canonicalDigest}`,
    ownerStartIdentityRef: `roi_${canonicalDigest}`,
  });
}

export class RuntimeOwnerDaemon<Service extends RuntimeOwnerDaemonService = RuntimeOwnerService> {
  readonly service: Service;
  readonly completed: Promise<void>;
  readonly #signalTarget: RuntimeOwnerDaemonSignalTarget;
  readonly #onSignal: () => void;
  #stopPromise: Promise<void> | undefined;

  constructor(service: Service, signalTarget: RuntimeOwnerDaemonSignalTarget = process) {
    this.service = service;
    this.#signalTarget = signalTarget;
    this.completed = service.completed;
    this.#onSignal = () => {
      void this.stop().catch(() => {
        // stop() retains the fixed lifecycle failure for an explicit caller; signals still detach.
      });
    };
    signalTarget.on("SIGINT", this.#onSignal);
    signalTarget.on("SIGTERM", this.#onSignal);
    void this.completed.then(
      () => this.#removeSignalListeners(),
      () => this.#removeSignalListeners(),
    );
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#removeSignalListeners();
    this.#stopPromise = this.service.stop();
    return this.#stopPromise;
  }

  #removeSignalListeners(): void {
    this.#signalTarget.off("SIGINT", this.#onSignal);
    this.#signalTarget.off("SIGTERM", this.#onSignal);
  }
}

export async function startRuntimeOwnerDaemon<Database extends RuntimeOwnerHostStateDatabase>(
  options: StartRuntimeOwnerDaemonOptions<Database>,
): Promise<RuntimeOwnerDaemon<RuntimeOwnerService<Database>>> {
  const ownerIdentity = readLinuxRuntimeOwnerProcessStartIdentity(
    options.service.machineIdentityId,
    options.processIdentityDependencies,
  );
  const startService = options.startService ?? startRuntimeOwnerService;
  const service = await startService({ ...options.service, ownerIdentity });
  return new RuntimeOwnerDaemon(service, options.signalTarget ?? process);
}
