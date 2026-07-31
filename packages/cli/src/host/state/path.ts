import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HostStateContractError, parseMachineIdentityId } from "./ids.js";

export const HOST_STATE_DATABASE_BASENAME = "host-state-v1.db";

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
export function resolveHostStateDatabasePath(
  machineIdentityId: string,
  environment: HostStatePathEnvironment = currentEnvironment(),
): string {
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
  return resolve(stateHome, "remote-claw", "identities", identity, HOST_STATE_DATABASE_BASENAME);
}
