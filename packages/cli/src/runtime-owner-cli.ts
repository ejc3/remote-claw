import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveIdentity, type Identity, toHex } from "@remote-claw/clawsec";
import {
  type StartProductionRuntimeOwnerDaemonOptions,
  startProductionRuntimeOwnerDaemon,
} from "./host/runtime-owner/production.js";
import { loadSecret } from "./store.js";

const MACHINE_IDENTITY = /^[0-9a-f]{32}$/;

interface RuntimeOwnerCliArguments {
  readonly machineIdentityId: string;
  readonly secretFilePath: string;
}

export interface RuntimeOwnerCliDaemon {
  readonly completed: Promise<void>;
}

export interface RuntimeOwnerCliDependencies {
  readonly loadSecret?: typeof loadSecret;
  readonly deriveIdentity?: typeof deriveIdentity;
  readonly startDaemon?: (
    options: StartProductionRuntimeOwnerDaemonOptions,
  ) => Promise<RuntimeOwnerCliDaemon>;
  readonly stderr?: (line: string) => void;
}

function parseArguments(argv: readonly string[]): RuntimeOwnerCliArguments | null {
  if (argv.length !== 4) return null;
  let machineIdentityId: string | undefined;
  let secretFilePath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.includes("\0")) return null;
    if (name === "--machine-identity" && machineIdentityId === undefined) {
      machineIdentityId = value;
    } else if (name === "--secret-file" && secretFilePath === undefined) {
      secretFilePath = value;
    } else {
      return null;
    }
  }
  if (
    machineIdentityId === undefined ||
    !MACHINE_IDENTITY.test(machineIdentityId) ||
    secretFilePath === undefined ||
    !isAbsolute(secretFilePath)
  ) {
    return null;
  }
  return Object.freeze({ machineIdentityId, secretFilePath });
}

function eraseIdentity(identity: Identity | undefined): void {
  if (identity === undefined) return;
  identity.authToken.fill(0);
  identity.identityId.fill(0);
  identity.contentRoot.fill(0);
  identity.controlKey.fill(0);
  identity.kMeta.fill(0);
}

/** Private daemon entry. Its diagnostics are deliberately fixed and contain no argv or secret data. */
export async function runRuntimeOwnerCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: RuntimeOwnerCliDependencies = {},
): Promise<number> {
  const parsed = parseArguments(argv);
  const stderr = dependencies.stderr ?? ((line: string) => process.stderr.write(line));
  if (parsed === null) {
    stderr("remote-claw: runtime owner invocation is invalid\n");
    return 2;
  }
  const readSecret = dependencies.loadSecret ?? loadSecret;
  const derive = dependencies.deriveIdentity ?? deriveIdentity;
  const startDaemon = dependencies.startDaemon ?? startProductionRuntimeOwnerDaemon;
  let secret: Uint8Array | undefined;
  let identity: Identity | undefined;
  try {
    ({ secret } = await readSecret(parsed.secretFilePath));
    identity = await derive(secret);
    const derivedMachineIdentityId = toHex(identity.identityId);
    eraseIdentity(identity);
    identity = undefined;
    if (derivedMachineIdentityId !== parsed.machineIdentityId) {
      throw new Error("machine identity mismatch");
    }
    const daemon = await startDaemon({
      machineIdentityId: parsed.machineIdentityId,
      identitySecret: secret,
    });
    secret.fill(0);
    secret = undefined;
    await daemon.completed;
    return 0;
  } catch {
    stderr("remote-claw: runtime owner is unavailable\n");
    return 1;
  } finally {
    eraseIdentity(identity);
    secret?.fill(0);
  }
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectInvocation()) {
  process.exitCode = await runRuntimeOwnerCli();
}
