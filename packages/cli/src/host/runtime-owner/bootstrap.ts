import {
  type ConnectRuntimeOwnerRpcOptions,
  connectRuntimeOwnerRpc,
  type RuntimeOwnerRpcClient,
} from "./client.js";
import { RuntimeOwnerRpcError } from "./protocol.js";

const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_CONNECT_TIMEOUT_MS = 500;

type MaybePromise<T> = T | Promise<T>;

/** Intentionally contains no argv, environment, file contents, or secret bytes. */
export interface RuntimeOwnerDetachedSpawnRequest {
  readonly machineIdentityId: string;
  readonly detached: true;
}

export interface BootstrapRuntimeOwnerOptions {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly spawnDetached: (request: RuntimeOwnerDetachedSpawnRequest) => MaybePromise<void>;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly connect?: (options: ConnectRuntimeOwnerRpcOptions) => Promise<RuntimeOwnerRpcClient>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type BootstrapRuntimeOwnerResult =
  | Readonly<{
      status: "connected";
      client: RuntimeOwnerRpcClient;
      spawnAttempted: boolean;
    }>
  | Readonly<{
      status: "unavailable";
      client: null;
      spawnAttempted: boolean;
    }>;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  return selected;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unavailable(spawnAttempted: boolean): BootstrapRuntimeOwnerResult {
  return Object.freeze({ status: "unavailable", client: null, spawnAttempted });
}

function retryableConnectFailure(error: unknown): boolean {
  return (
    error instanceof RuntimeOwnerRpcError &&
    (error.code === "UNAVAILABLE" || error.code === "CLOSED" || error.code === "TIMEOUT")
  );
}

/**
 * Connect-first preserves current A0 behavior: failure returns an inert unavailable result. This
 * function never kills a process, steals a lease, opens host state, or activates native registration.
 */
export async function bootstrapRuntimeOwner(
  options: BootstrapRuntimeOwnerOptions,
): Promise<BootstrapRuntimeOwnerResult> {
  if (!MACHINE_IDENTITY.test(options.machineIdentityId)) {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  const startupTimeoutMs = boundedInteger(
    options.startupTimeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    60_000,
  );
  const pollIntervalMs = boundedInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 5_000);
  const connectTimeoutMs = boundedInteger(
    options.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    60_000,
  );
  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 30_000, 300_000);
  if (!(options.identitySecret instanceof Uint8Array) || options.identitySecret.length !== 32) {
    throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
  }
  if (typeof options.spawnDetached !== "function") {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  const connect = options.connect ?? connectRuntimeOwnerRpc;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const secret = Uint8Array.from(options.identitySecret);
  let startedAt: number;
  try {
    startedAt = now();
  } catch {
    secret.fill(0);
    throw new RuntimeOwnerRpcError("UNAVAILABLE");
  }
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    secret.fill(0);
    throw new RuntimeOwnerRpcError("UNAVAILABLE");
  }
  const deadline = startedAt + startupTimeoutMs;
  if (!Number.isSafeInteger(deadline)) {
    secret.fill(0);
    throw new RuntimeOwnerRpcError("UNAVAILABLE");
  }
  const tryConnect = async (remainingMs: number): Promise<RuntimeOwnerRpcClient> =>
    connect({
      machineIdentityId: options.machineIdentityId,
      identitySecret: secret,
      handshakeTimeoutMs: Math.min(connectTimeoutMs, Math.max(1, remainingMs)),
      requestTimeoutMs,
    });
  const readNow = (): number | undefined => {
    try {
      const value = now();
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  try {
    try {
      const client = await tryConnect(startupTimeoutMs);
      return Object.freeze({ status: "connected", client, spawnAttempted: false });
    } catch (error) {
      if (!(error instanceof RuntimeOwnerRpcError) || error.code !== "UNAVAILABLE") {
        return unavailable(false);
      }
    }

    try {
      await options.spawnDetached(
        Object.freeze({ machineIdentityId: options.machineIdentityId, detached: true }),
      );
    } catch {
      return unavailable(true);
    }

    // The attempt cap is a second bound independent of wall-clock behavior. Clock regression or a
    // frozen injected clock cannot turn daemon startup into an infinite loop.
    const maximumPollAttempts = Math.ceil(startupTimeoutMs / pollIntervalMs) + 1;
    for (let attempt = 0; attempt < maximumPollAttempts; attempt++) {
      const beforeSleep = readNow();
      if (beforeSleep === undefined) return unavailable(true);
      const remainingBeforeSleep = deadline - beforeSleep;
      if (remainingBeforeSleep <= 0) break;
      try {
        await sleep(Math.min(pollIntervalMs, remainingBeforeSleep));
      } catch {
        return unavailable(true);
      }
      const afterSleep = readNow();
      if (afterSleep === undefined) return unavailable(true);
      const remaining = deadline - afterSleep;
      if (remaining <= 0) break;
      try {
        const client = await tryConnect(remaining);
        return Object.freeze({ status: "connected", client, spawnAttempted: true });
      } catch (error) {
        if (!retryableConnectFailure(error)) return unavailable(true);
      }
    }
    return unavailable(true);
  } finally {
    secret.fill(0);
  }
}
