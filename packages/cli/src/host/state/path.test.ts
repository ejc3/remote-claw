import { describe, expect, it } from "vitest";
import { HOST_STATE_DATABASE_BASENAME, resolveHostStateDatabasePath } from "./path.js";

const identity = "01".repeat(16);

describe("A1 host-state path", () => {
  it("uses an absolute XDG state root and namespaces by public identity", () => {
    expect(
      resolveHostStateDatabasePath(identity, {
        xdgStateHome: "/state",
        homeDirectory: "/home/example",
      }),
    ).toBe(`/state/remote-claw/identities/${identity}/${HOST_STATE_DATABASE_BASENAME}`);
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is absent or relative", () => {
    for (const xdgStateHome of [null, "relative/state"]) {
      expect(
        resolveHostStateDatabasePath(identity, {
          xdgStateHome,
          homeDirectory: "/home/example",
        }),
      ).toBe(
        `/home/example/.local/state/remote-claw/identities/${identity}/${HOST_STATE_DATABASE_BASENAME}`,
      );
    }
  });

  it("rejects malformed identity path components before path construction", () => {
    expect(() =>
      resolveHostStateDatabasePath("../escape", {
        xdgStateHome: "/state",
        homeDirectory: "/home/example",
      }),
    ).toThrow(/machineIdentityId/);
  });

  it("rejects a relative or empty fallback home instead of resolving beneath cwd", () => {
    for (const homeDirectory of ["relative/home", ""]) {
      expect(() =>
        resolveHostStateDatabasePath(identity, {
          xdgStateHome: "relative/state",
          homeDirectory,
        }),
      ).toThrow(/homeDirectory must be absolute/);
    }
  });

  it("snapshots injected environment fields once and normalizes malformed types", () => {
    let xdgReads = 0;
    let homeReads = 0;
    const environment = {
      get xdgStateHome() {
        xdgReads++;
        return xdgReads === 1 ? "/state" : "/changed";
      },
      get homeDirectory() {
        homeReads++;
        return homeReads === 1 ? "/home/example" : "/changed";
      },
    };
    expect(resolveHostStateDatabasePath(identity, environment)).toBe(
      `/state/remote-claw/identities/${identity}/${HOST_STATE_DATABASE_BASENAME}`,
    );
    expect(xdgReads).toBe(1);
    expect(homeReads).toBe(1);

    expect(() =>
      resolveHostStateDatabasePath(identity, {
        xdgStateHome: 1,
        homeDirectory: "/home/example",
      } as unknown as Parameters<typeof resolveHostStateDatabasePath>[1]),
    ).toThrow(/xdgStateHome must be a string or null/);
  });
});
