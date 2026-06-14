// Unit tests for the SessionStart-hook injection helpers: the settings DEEP-MERGE with any user
// `--settings` (the load-bearing requirement), the argv extraction, and the sentinel NDJSON parser.

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  extractSettingsArg,
  mergeSessionHookSettings,
  parseSentinel,
  parseUserSettings,
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
  it("registers a SessionStart command hook that appends NDJSON to the (quoted) sentinel", () => {
    const f = sessionHookFragment("/tmp/it's here.ndjson");
    const cmd = f.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(f.hooks.SessionStart[0]?.hooks[0]?.type).toBe("command");
    expect(cmd).toContain("cat >>");
    expect(cmd).toContain("printf"); // newline delimiter
    expect(cmd).toContain("'/tmp/it'\\''s here.ndjson'"); // single-quoted, escaped
  });
});

describe("parseUserSettings", () => {
  it("returns {} for null/blank", async () => {
    expect(await parseUserSettings(null)).toEqual({});
    expect(await parseUserSettings("   ")).toEqual({});
  });
  it("parses inline JSON objects; rejects non-objects → {}", async () => {
    expect(await parseUserSettings('{"model":"x"}')).toEqual({ model: "x" });
    expect(await parseUserSettings("[1,2]")).toEqual({}); // array is not a settings object
    expect(await parseUserSettings("not json")).toEqual({});
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
    const out = JSON.parse(await mergeSessionHookSettings(null, sentinel));
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
    const out = JSON.parse(await mergeSessionHookSettings(user, sentinel));
    expect(out.model).toBe("sonnet"); // preserved
    expect(out.permissions).toEqual({ allow: ["Bash"] }); // preserved
    expect(out.hooks.PreToolUse).toHaveLength(1); // other hook event preserved
    // their SessionStart kept, ours appended
    expect(out.hooks.SessionStart).toHaveLength(2);
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe("echo theirs");
    expect(out.hooks.SessionStart[1].hooks[0].command).toContain("/tmp/s.ndjson");
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
