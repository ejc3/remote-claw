import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HostStateContractError, parseMachineIdentityId } from "./ids.js";

export const HOST_STATE_DATABASE_BASENAME = "host-state-v1.db";

export interface HostStatePaths {
  readonly stateHomePath: string;
  readonly applicationDirectoryPath: string;
  readonly identitiesDirectoryPath: string;
  readonly identityDirectoryPath: string;
  readonly databasePath: string;
  readonly walPath: string;
  readonly shmPath: string;
  readonly journalPath: string;
}

export interface HostStatePathEnvironment {
  readonly xdgStateHome: string | null;
  readonly homeDirectory: string;
}

function currentEnvironment(): HostStatePathEnvironment {
  return {
    xdgStateHome: process.env.XDG_STATE_HOME || null,
    homeDirectory: homedir(),
  };
}

/**
 * Resolve the identity-namespaced A1 database path without touching the
 * filesystem. A relative XDG_STATE_HOME is invalid under the XDG spec and is
 * ignored just as it is for the existing secret store.
 */
export function resolveHostStatePaths(
  machineIdentityId: string,
  environment: HostStatePathEnvironment = currentEnvironment(),
): HostStatePaths {
  const identity = parseMachineIdentityId(machineIdentityId);
  const xdgStateHome = environment.xdgStateHome;
  const homeDirectory = environment.homeDirectory;
  if (xdgStateHome !== null && typeof xdgStateHome !== "string") {
    throw new HostStateContractError("hostStatePath.xdgStateHome must be a string or null");
  }
  if (typeof homeDirectory !== "string") {
    throw new HostStateContractError("hostStatePath.homeDirectory must be a string");
  }
  let stateHome: string;
  if (xdgStateHome !== null && isAbsolute(xdgStateHome)) {
    stateHome = xdgStateHome;
  } else {
    if (!isAbsolute(homeDirectory)) {
      throw new HostStateContractError(
        "hostStatePath.homeDirectory must be absolute when XDG_STATE_HOME is unavailable",
      );
    }
    stateHome = join(homeDirectory, ".local", "state");
  }
  const normalizedStateHome = resolve(stateHome);
  const applicationDirectoryPath = join(normalizedStateHome, "remote-claw");
  const identitiesDirectoryPath = join(applicationDirectoryPath, "identities");
  const identityDirectoryPath = join(identitiesDirectoryPath, identity);
  const databasePath = join(identityDirectoryPath, HOST_STATE_DATABASE_BASENAME);
  return Object.freeze({
    stateHomePath: normalizedStateHome,
    applicationDirectoryPath,
    identitiesDirectoryPath,
    identityDirectoryPath,
    databasePath,
    walPath: `${databasePath}-wal`,
    shmPath: `${databasePath}-shm`,
    journalPath: `${databasePath}-journal`,
  });
}

export function resolveHostStateDatabasePath(
  machineIdentityId: string,
  environment: HostStatePathEnvironment = currentEnvironment(),
): string {
  return resolveHostStatePaths(machineIdentityId, environment).databasePath;
}
