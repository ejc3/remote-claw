// Unit tests for the SessionStart-hook injection helpers: the settings DEEP-MERGE with any user
// `--settings` (the load-bearing requirement), the argv extraction, and the sentinel NDJSON parser.

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  extractSettingsArg,
  insertSettingsArg,
  mergeSessionHookSettings,
  parseSentinel,
  parseUserSettings,
  resolveInjectSessionHook,
  sessionHookFragment,
} from "./sessionhook.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rc-sessionhook-"));
  dirs.push(d);
  return d;
};

describe("sessionHookFragment", () => {
  it("registers a SessionStart command hook that atomically appends NDJSON to the (quoted) sentinel", () => {
    const f = sessionHookFragment("/tmp/it's here.ndjson");
    const cmd = f.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(f.hooks.SessionStart[0]?.hooks[0]?.type).toBe("command");
    // ONE O_APPEND write (printf '%s\n' "$(cat)" >> p) — not two separate appends that could interleave.
    expect(cmd).toBe(`printf '%s\\n' "$(cat)" >> '/tmp/it'\\''s here.ndjson'`);
    expect(cmd).not.toContain(";"); // single command, single append (no `cat >> p; printf >> p`)
  });
});

describe("parseUserSettings", () => {
  it("returns {} for null/blank", async () => {
    expect(await parseUserSettings(null)).toEqual({});
    expect(await parseUserSettings("   ")).toEqual({});
  });
  it("returns the OBJECT when usable; null when non-empty but unparseable (→ caller falls back)", async () => {
    expect(await parseUserSettings('{"model":"x"}')).toEqual({ model: "x" });
    expect(await parseUserSettings("[1,2]")).toBeNull(); // array is not a settings object
    expect(await parseUserSettings("not json")).toBeNull(); // invalid JSON, not a file
    expect(await parseUserSettings("/no/such/file/at/all.json")).toBeNull(); // missing file
  });
  it("reads a file path when the value isn't inline JSON", async () => {
    const dir = tmp();
    const p = join(dir, "settings.json");
    await writeFile(p, JSON.stringify({ permissions: { allow: ["Bash"] } }));
    expect(await parseUserSettings(p)).toEqual({ permissions: { allow: ["Bash"] } });
  });
});

describe("mergeSessionHookSettings — merge with the user's --settings", () => {
  const sentinel = "/tmp/s.ndjson";
  it("injects our hook when the user has no settings", async () => {
    const s = await mergeSessionHookSettings(null, sentinel);
    expect(s).not.toBeNull();
    const out = JSON.parse(s as string);
    expect(out.hooks.SessionStart).toHaveLength(1);
    expect(out.hooks.SessionStart[0].hooks[0].command).toContain("/tmp/s.ndjson");
  });
  it("PRESERVES the user's other settings + other hook events, APPENDS our SessionStart", async () => {
    const user = JSON.stringify({
      model: "sonnet",
      permissions: { allow: ["Bash"] },
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo theirs" }] }],
      },
    });
    const s = await mergeSessionHookSettings(user, sentinel);
    expect(s).not.toBeNull();
    const out = JSON.parse(s as string);
    expect(out.model).toBe("sonnet"); // preserved
    expect(out.permissions).toEqual({ allow: ["Bash"] }); // preserved
    expect(out.hooks.PreToolUse).toHaveLength(1); // other hook event preserved
    // their SessionStart kept, ours appended
    expect(out.hooks.SessionStart).toHaveLength(2);
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe("echo theirs");
    expect(out.hooks.SessionStart[1].hooks[0].command).toContain("/tmp/s.ndjson");
  });
  it("returns null when the user passed a --settings we can't parse (caller falls back, no hook)", async () => {
    expect(await mergeSessionHookSettings("not json", sentinel)).toBeNull();
    expect(await mergeSessionHookSettings("[1,2]", sentinel)).toBeNull();
    expect(await mergeSessionHookSettings("/no/such/file.json", sentinel)).toBeNull();
  });
});

describe("extractSettingsArg", () => {
  it("pulls --settings <val> and removes it from the args", () => {
    expect(extractSettingsArg(["--model", "x", "--settings", "{}", "--foo"])).toEqual({
      value: "{}",
      rest: ["--model", "x", "--foo"],
    });
  });
  it("pulls the --settings=<val> form", () => {
    expect(extractSettingsArg(['--settings={"a":1}', "--model", "x"])).toEqual({
      value: '{"a":1}',
      rest: ["--model", "x"],
    });
  });
  it("no --settings → value null, args unchanged", () => {
    expect(extractSettingsArg(["--model", "x"])).toEqual({ value: null, rest: ["--model", "x"] });
  });
  it("ignores a --settings AFTER a -- separator (it's a literal)", () => {
    expect(extractSettingsArg(["--", "--settings", "x"])).toEqual({
      value: null,
      rest: ["--", "--settings", "x"],
    });
  });
  it("on multiple --settings, the LAST wins and ALL are stripped (matches claude; never leaks one that would override our merge)", () => {
    expect(
      extractSettingsArg(["--settings", "a", "--model", "x", '--settings={"b":1}', "--foo"]),
    ).toEqual({ value: '{"b":1}', rest: ["--model", "x", "--foo"] });
    // mixed forms, three occurrences → last value, none left behind
    expect(extractSettingsArg(["--settings=one", "--settings", "two", "--settings=three"])).toEqual(
      {
        value: "three",
        rest: [],
      },
    );
  });
  it("a --settings whose value would be the -- separator is dropped (doesn't swallow the separator)", () => {
    expect(extractSettingsArg(["--settings", "--", "x"])).toEqual({
      value: null,
      rest: ["--", "x"],
    });
  });
});

describe("insertSettingsArg", () => {
  it("appends --settings when there is no -- separator", () => {
    expect(insertSettingsArg(["chat", "--model", "x"], "{}")).toEqual([
      "chat",
      "--model",
      "x",
      "--settings",
      "{}",
    ]);
  });
  it("inserts --settings BEFORE a -- separator (so claude parses it as an option, not a literal)", () => {
    // Regression: appending after `--` would make claude treat --settings as a prompt token and DROP the hook.
    expect(insertSettingsArg(["chat", "--", "hello world"], "{}")).toEqual([
      "chat",
      "--settings",
      "{}",
      "--",
      "hello world",
    ]);
  });
  it("inserts at the front when -- is the first token", () => {
    expect(insertSettingsArg(["--", "prompt"], "{}")).toEqual(["--settings", "{}", "--", "prompt"]);
  });
});

describe("resolveInjectSessionHook — precedence + the disable set", () => {
  const r = (noFlag: boolean, yesFlag: boolean, env?: string) =>
    resolveInjectSessionHook({ noFlag, yesFlag, env });
  it("defaults ON with no flags and no env", () => {
    expect(r(false, false, undefined)).toBe(true);
    expect(r(false, false, "")).toBe(true);
  });
  it("--rc-no-session-hook wins over everything (off)", () => {
    expect(r(true, true, "1")).toBe(false);
    expect(r(true, false, undefined)).toBe(false);
  });
  it("--rc-session-hook forces on (overrides a falsey env)", () => {
    expect(r(false, true, "off")).toBe(true);
    expect(r(false, true, "0")).toBe(true);
  });
  it("RC_SESSION_HOOK disables for 0/false/no/off (case- + whitespace-insensitive)", () => {
    for (const v of ["0", "false", "no", "off", " OFF ", "False"]) {
      expect(r(false, false, v)).toBe(false);
    }
  });
  it("RC_SESSION_HOOK leaves it ON for any other value", () => {
    for (const v of ["1", "true", "yes", "on", "anything"]) {
      expect(r(false, false, v)).toBe(true);
    }
  });
});

describe("parseSentinel", () => {
  const ev = (id: string, path: string) =>
    JSON.stringify({ session_id: id, transcript_path: path, cwd: "/c", source: "startup" });
  it("returns null for empty/garbage", () => {
    expect(parseSentinel("")).toBeNull();
    expect(parseSentinel("\n  \n{bad")).toBeNull();
  });
  it("returns the single event (normalized)", () => {
    expect(parseSentinel(`${ev("id1", "/p/id1.jsonl")}\n`)).toEqual({
      sessionId: "id1",
      transcriptPath: "/p/id1.jsonl",
      cwd: "/c",
      source: "startup",
    });
  });
  it("returns the LAST event on rotation (a new line = a /clear or /branch)", () => {
    const text = `${ev("id1", "/p/id1.jsonl")}\n${ev("id2", "/p/id2.jsonl")}\n`;
    expect(parseSentinel(text)?.transcriptPath).toBe("/p/id2.jsonl");
  });
  it("skips a torn trailing line (mid-append) but keeps the last complete event", () => {
    const text = `${ev("id1", "/p/id1.jsonl")}\n{"session_id":"id2","transcr`;
    expect(parseSentinel(text)?.sessionId).toBe("id1");
  });
  it("ignores events missing session_id or transcript_path", () => {
    expect(parseSentinel(`${JSON.stringify({ session_id: "x" })}\n`)).toBeNull();
    expect(parseSentinel(`${JSON.stringify({ transcript_path: "/p" })}\n`)).toBeNull();
  });
});
