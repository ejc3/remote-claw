import { describe, expect, it } from "vitest";
import { envLocalAdditions } from "./vitest-env-local.js";

// Pins the shell-WINS precedence of the .env.local loader (vitest.setup.ts). CI has no .env.local, so
// only this unit test guards the regression where a stale/committed .env.local value would override an
// explicit shell var (e.g. `RC_OPENCODE_E2E_MODEL=… pnpm test`).
describe("envLocalAdditions", () => {
  it("fills only keys absent from the existing env", () => {
    const out = envLocalAdditions({ A: "shell" }, { A: "file", B: "file" });
    expect(out).toEqual({ B: "file" }); // A already set → not overridden; B is new → filled
  });

  it("shell WINS even when the shell value is an empty string (present, not absent)", () => {
    // An explicitly-exported empty var is still 'set' — `=== undefined` is the right presence test, a
    // truthiness check would wrongly let the file clobber it.
    expect(envLocalAdditions({ A: "" }, { A: "file" })).toEqual({});
  });

  it("returns an empty object for an empty file (the common no-config case)", () => {
    expect(envLocalAdditions({ A: "shell" }, {})).toEqual({});
  });

  it("skips non-string parsed values (defensive — parseEnv only yields strings)", () => {
    const parsed = { A: 1, B: undefined, C: "ok" } as unknown as Record<string, unknown>;
    expect(envLocalAdditions({}, parsed)).toEqual({ C: "ok" });
  });
});
