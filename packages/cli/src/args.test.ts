import { describe, expect, it } from "vitest";
import { classifyArgs } from "./args.js";

describe("classifyArgs (unit)", () => {
  it("forwards non-rc tokens verbatim to claude", () => {
    expect(classifyArgs(["chat", "--model", "opus", "-p", "hi"])).toEqual({
      rc: {},
      claudeArgs: ["chat", "--model", "opus", "-p", "hi"],
      errors: [],
    });
  });

  it("parses boolean rc flags", () => {
    const c = classifyArgs(["--rc-identity", "chat"]);
    expect(c.rc).toEqual({ "rc-identity": true });
    expect(c.claudeArgs).toEqual(["chat"]);
    expect(c.errors).toEqual([]);
  });

  it("parses value rc flags in space and = forms", () => {
    expect(classifyArgs(["--rc-file", "work"]).rc).toEqual({ "rc-file": "work" });
    expect(classifyArgs(["--rc-file=work"]).rc).toEqual({ "rc-file": "work" });
    expect(classifyArgs(["--rc-file=", "x"])).toMatchObject({
      rc: { "rc-file": "" },
      claudeArgs: ["x"],
    });
  });

  it("parses --rc-backend (the host's broker-backend selector) as a value flag", () => {
    expect(classifyArgs(["--rc-backend", "sqlite", "chat"]).rc).toEqual({ "rc-backend": "sqlite" });
    expect(classifyArgs(["--rc-backend=sqlite"]).rc).toEqual({ "rc-backend": "sqlite" });
  });

  it("reserves the exact Claude-native attach session without forwarding it", () => {
    expect(classifyArgs(["--rc-native-session", "cse_native", "chat"])).toEqual({
      rc: { "rc-native-session": "cse_native" },
      claudeArgs: ["chat"],
      errors: [],
    });
  });

  it("reserves the Codex app-server origin and exact thread without forwarding them", () => {
    expect(
      classifyArgs([
        "--rc-codex-url",
        "ws://127.0.0.1:4500",
        "--rc-codex-thread",
        "0194f8d8-10b4-7abc-8def-0123456789ab",
        "chat",
      ]),
    ).toEqual({
      rc: {
        "rc-codex-url": "ws://127.0.0.1:4500",
        "rc-codex-thread": "0194f8d8-10b4-7abc-8def-0123456789ab",
      },
      claudeArgs: ["chat"],
      errors: [],
    });
  });

  it("mixes rc flags and claude args in any order", () => {
    const c = classifyArgs(["chat", "--rc-file", "work", "--model", "opus", "--rc-quiet"]);
    expect(c.rc).toEqual({ "rc-file": "work", "rc-quiet": true });
    expect(c.claudeArgs).toEqual(["chat", "--model", "opus"]);
    expect(c.errors).toEqual([]);
  });

  it("treats -- as an escape: everything after is claude's, verbatim", () => {
    const c = classifyArgs(["--rc-quiet", "a", "--", "--rc-identity", "-x", "--model"]);
    expect(c.rc).toEqual({ "rc-quiet": true });
    expect(c.claudeArgs).toEqual(["a", "--", "--rc-identity", "-x", "--model"]);
  });

  it("does not reserve --rcfoo (only --rc-<name>)", () => {
    expect(classifyArgs(["--rcfoo"]).claudeArgs).toEqual(["--rcfoo"]);
  });

  it("errors on unknown rc flags", () => {
    expect(classifyArgs(["--rc-bogus"]).errors).toEqual(["unknown flag --rc-bogus"]);
  });

  it("no longer reserves --rc-share or --rc-web (removed from the namespace)", () => {
    // --rc-share: claude's own --remote-control covers it. --rc-web: collapsed into --rc-app.
    expect(classifyArgs(["--rc-share"]).errors).toEqual(["unknown flag --rc-share"]);
    expect(classifyArgs(["--rc-web=https://x"]).errors).toEqual(["unknown flag --rc-web"]);
    // claude's --remote-control is NOT an rc flag — it forwards through untouched.
    expect(classifyArgs(["--remote-control"]).claudeArgs).toEqual(["--remote-control"]);
  });

  it("errors when a boolean flag is given a value", () => {
    expect(classifyArgs(["--rc-identity=x"]).errors).toEqual(["--rc-identity takes no value"]);
  });

  it("registers driver permission flags as booleans (else the parser rejects them)", () => {
    // The retired OpenCode inverse remains reserved solely so run.ts can emit its targeted migration
    // error; the positive flag is the only OpenCode permission configuration.
    for (const flag of [
      "rc-tmux-skip-permissions",
      "rc-oc-mirror-permissions",
      "rc-oc-skip-permissions",
    ]) {
      const c = classifyArgs(["chat", `--${flag}`]);
      expect(c.errors).toEqual([]);
      expect(c.rc[flag]).toBe(true);
      expect(c.claudeArgs).toEqual(["chat"]); // consumed, not leaked to claude
      expect(classifyArgs([`--${flag}=1`]).errors).toEqual([`--${flag} takes no value`]);
    }
  });

  it("errors when a value flag is missing its value or followed by a flag (never swallows it)", () => {
    expect(classifyArgs(["--rc-file"]).errors).toHaveLength(1);
    expect(classifyArgs(["--rc-file"]).errors[0]).toMatch(/--rc-file requires a value/);
    // crucially, a value flag must NOT eat a following claude flag (--model / -p) or rc flag
    for (const next of ["--rc-show-secret", "--", "--model", "-p", "-"]) {
      const c = classifyArgs(["--rc-file", next]);
      expect(c.errors).toHaveLength(1);
      expect(c.rc["rc-file"]).toBeUndefined();
    }
  });

  it("accepts a dash-leading value only via the = form", () => {
    expect(classifyArgs(["--rc-file=-x"]).rc).toEqual({ "rc-file": "-x" });
    expect(classifyArgs(["--rc-app=--weird"]).rc).toEqual({ "rc-app": "--weird" });
  });

  it("collects multiple errors", () => {
    const errs = classifyArgs(["--rc-bogus", "--rc-file"]).errors;
    expect(errs).toHaveLength(2);
    expect(errs[0]).toBe("unknown flag --rc-bogus");
    expect(errs[1]).toMatch(/--rc-file requires a value/);
  });
});
