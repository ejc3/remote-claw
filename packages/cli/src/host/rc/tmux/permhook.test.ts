import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decisionFileContent,
  isSafeToolUseId,
  PRE_TOOL_USE_HELPER_SOURCE,
  parsePermRequest,
  preToolUseHookCommand,
  preToolUseHookFragment,
  resolveMirrorPermissions,
} from "./permhook.js";
import { mergeHookFragments, sessionHookFragment } from "./sessionhook.js";

describe("resolveMirrorPermissions (default ON, opt-out)", () => {
  it("defaults ON (no flag, no env)", () => {
    expect(resolveMirrorPermissions({ skipFlag: false, env: undefined })).toBe(true);
    expect(resolveMirrorPermissions({ skipFlag: false, env: "" })).toBe(true);
  });
  it("the --rc-tmux-skip-permissions flag turns it OFF", () => {
    expect(resolveMirrorPermissions({ skipFlag: true, env: undefined })).toBe(false);
  });
  it("a truthy RC_TMUX_SKIP_PERMISSIONS turns it OFF (case/space-insensitive)", () => {
    for (const v of ["1", "true", "YES", " on "]) {
      expect(resolveMirrorPermissions({ skipFlag: false, env: v })).toBe(false);
    }
  });
  it("a non-truthy env leaves it ON", () => {
    for (const v of ["0", "false", "no", "off", "garbage"]) {
      expect(resolveMirrorPermissions({ skipFlag: false, env: v })).toBe(true);
    }
  });
});

describe("preToolUseHookCommand", () => {
  it("builds `<node> <helper> <req> <dec> <poll>` with every token single-quoted", () => {
    const cmd = preToolUseHookCommand("/run/h.mjs", "/run/req.ndjson", "/run/dec", 100);
    expect(cmd).toBe("'node' '/run/h.mjs' '/run/req.ndjson' '/run/dec' '100'");
  });

  it("uses the provided (absolute) node interpreter, single-quoted, so a bare `node` PATH miss can't break it", () => {
    const cmd = preToolUseHookCommand("/run/h.mjs", "/run/req", "/run/dec", 100, "/abs/bin/node");
    expect(cmd.startsWith("'/abs/bin/node' '/run/h.mjs'")).toBe(true);
  });

  it("escapes single quotes / spaces in paths so the shell can't split or break them", () => {
    const cmd = preToolUseHookCommand("/r u n/it's.mjs", "/r/req", "/r/dec", 50);
    // a path with a space + apostrophe survives intact (the apostrophe is closed-escaped-reopened)
    expect(cmd).toContain("'/r u n/it'\\''s.mjs'");
    expect(cmd).toContain("'50'");
  });
});

describe("preToolUseHookFragment", () => {
  it("registers a PreToolUse hook matching every tool (matcher '*')", () => {
    const frag = preToolUseHookFragment("/h.mjs", "/req", "/dec");
    expect(frag.hooks.PreToolUse).toHaveLength(1);
    const entry = frag.hooks.PreToolUse[0];
    expect(entry?.matcher).toBe("*");
    expect(entry?.hooks[0]?.type).toBe("command");
    expect(entry?.hooks[0]?.command).toContain("'node' '/h.mjs'");
  });

  it("threads a custom node interpreter through to the command", () => {
    const frag = preToolUseHookFragment("/h.mjs", "/req", "/dec", 100, "/abs/bin/node");
    expect(frag.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("'/abs/bin/node' '/h.mjs'");
  });
});

describe("isSafeToolUseId (decision-file basename guard)", () => {
  it("accepts real + synthetic ids", () => {
    expect(isSafeToolUseId("toolu_01A09q90qw90lq917835lq9")).toBe(true);
    expect(isSafeToolUseId("notu-12345-1719600000000-a1b2c3")).toBe(true);
    expect(isSafeToolUseId("perm-x.Y_z:1")).toBe(true);
  });
  it("rejects path separators, traversal, empty, and over-long ids", () => {
    expect(isSafeToolUseId("")).toBe(false);
    expect(isSafeToolUseId("../../etc/passwd")).toBe(false);
    expect(isSafeToolUseId("a/b")).toBe(false);
    expect(isSafeToolUseId("a\\b")).toBe(false);
    expect(isSafeToolUseId("..")).toBe(false);
    expect(isSafeToolUseId("a..b")).toBe(false); // contains ".." anywhere
    expect(isSafeToolUseId("x".repeat(201))).toBe(false);
  });
});

describe("mergeHookFragments (SessionStart + PreToolUse coexist)", () => {
  it("appends BOTH hook events into the user's settings, preserving other keys + events", () => {
    const base = {
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo user-start" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "echo user-post" }] }],
      },
    };
    const merged = mergeHookFragments(base, [
      sessionHookFragment("/sentinel"),
      preToolUseHookFragment("/h.mjs", "/req", "/dec"),
    ]) as { model: string; hooks: Record<string, unknown[]> };
    // other top-level key preserved
    expect(merged.model).toBe("opus");
    // the user's SessionStart is kept AND ours is appended (2 entries)
    expect(merged.hooks.SessionStart).toHaveLength(2);
    // a brand-new PreToolUse event is added
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    // an unrelated hook event the user had is untouched
    expect(merged.hooks.PostToolUse).toHaveLength(1);
  });

  it("adds PreToolUse fresh when the user had no hooks at all", () => {
    const merged = mergeHookFragments({}, [preToolUseHookFragment("/h.mjs", "/req", "/dec")]) as {
      hooks: Record<string, unknown[]>;
    };
    expect(merged.hooks.PreToolUse).toHaveLength(1);
  });
});

describe("parsePermRequest", () => {
  it("parses a well-formed request line", () => {
    const line = JSON.stringify({
      toolUseId: "tu_1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      sessionId: "cse_x",
      permissionMode: "default",
    });
    expect(parsePermRequest(line)).toEqual({
      toolUseId: "tu_1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      sessionId: "cse_x",
      permissionMode: "default",
    });
  });

  it("returns null for blank / torn / non-object / missing-toolUseId lines", () => {
    expect(parsePermRequest("")).toBeNull();
    expect(parsePermRequest("   ")).toBeNull();
    expect(parsePermRequest('{"toolUseId":')).toBeNull(); // torn mid-append
    expect(parsePermRequest("[]")).toBeNull();
    expect(parsePermRequest(JSON.stringify({ toolName: "Bash" }))).toBeNull(); // no id
    expect(parsePermRequest(JSON.stringify({ toolUseId: "" }))).toBeNull(); // empty id
  });

  it("defaults missing/ill-typed optional fields", () => {
    expect(parsePermRequest(JSON.stringify({ toolUseId: "tu_2" }))).toEqual({
      toolUseId: "tu_2",
      toolName: "tool",
      toolInput: null,
      sessionId: "",
      permissionMode: "",
    });
  });
});

describe("decisionFileContent", () => {
  it("serializes allow/deny with an optional reason", () => {
    expect(decisionFileContent("allow")).toBe('{"behavior":"allow"}');
    expect(decisionFileContent("deny", "blocked by viewer")).toBe(
      '{"behavior":"deny","reason":"blocked by viewer"}',
    );
  });
  it("includes AskUserQuestion updatedInput on an ALLOW only (#42)", () => {
    const updatedInput = { questions: [{ question: "Q?" }], answers: { "Q?": "A" } };
    expect(JSON.parse(decisionFileContent("allow", undefined, updatedInput))).toEqual({
      behavior: "allow",
      updatedInput,
    });
    // A deny never carries updatedInput (the tool won't run) — even if one is passed.
    expect(JSON.parse(decisionFileContent("deny", "no", updatedInput))).toEqual({
      behavior: "deny",
      reason: "no",
    });
  });
});

// The helper is the load-bearing, otherwise-untested blocking loop. Run it as a REAL subprocess (no live
// claude needed): feed a PreToolUse payload on stdin, wait for it to surface the request, write a decision
// file, and assert it emits the matching PreToolUse hookSpecificOutput and exits. Proves the full
// append-request → block-poll → decide → emit cycle.
describe("PRE_TOOL_USE_HELPER_SOURCE (subprocess)", () => {
  async function runHelper(
    payload: Record<string, unknown>,
    decide: (req: { toolUseId: string; toolName: string }) => {
      behavior: "allow" | "deny";
      reason?: string;
      updatedInput?: unknown;
      /** Write this verbatim as the decision file instead of decisionFileContent(...) — lets a test feed
       *  a RAW shape (e.g. a deny that DOES carry updatedInput) to exercise the helper's OWN guards. */
      raw?: string;
    },
  ): Promise<{ stdout: string; requestLine: unknown }> {
    const dir = await mkdtemp(join(tmpdir(), "permhook-"));
    const helper = join(dir, "perm-hook.mjs");
    const reqSentinel = join(dir, "req.ndjson");
    const decisionDir = dir; // decisions land at <dir>/<id>.json
    await writeFile(helper, PRE_TOOL_USE_HELPER_SOURCE, "utf8");

    const child = spawn(process.execPath, [helper, reqSentinel, decisionDir, "20"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    // Wait until the helper has surfaced the request, then answer it.
    let requestLine: unknown = null;
    for (let i = 0; i < 200 && requestLine === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        const txt = await readFile(reqSentinel, "utf8");
        const first = txt.split("\n").find((l) => l.trim() !== "");
        if (first) requestLine = JSON.parse(first);
      } catch {
        /* not written yet */
      }
    }
    if (requestLine === null) {
      child.kill("SIGKILL");
      throw new Error("helper never wrote a request line");
    }
    const req = requestLine as { toolUseId: string; toolName: string };
    const d = decide(req);
    await writeFile(
      join(decisionDir, `${req.toolUseId}.json`),
      d.raw ?? decisionFileContent(d.behavior, d.reason, d.updatedInput),
    );

    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    return { stdout, requestLine };
  }

  it("surfaces the request, blocks, then emits ALLOW when the decision file says allow", async () => {
    const { stdout, requestLine } = await runHelper(
      {
        tool_use_id: "tu_live",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "cse_a",
        permission_mode: "default",
      },
      () => ({ behavior: "allow" }),
    );
    expect((requestLine as { toolName: string }).toolName).toBe("Bash");
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  it("emits ALLOW with updatedInput {questions, answers} for an AskUserQuestion answer (#42)", async () => {
    const questions = [{ question: "Which name?", header: "Name", options: [{ label: "Orion" }] }];
    const answers = { "Which name?": "Orion" };
    const { stdout } = await runHelper(
      {
        tool_use_id: "tu_askq",
        tool_name: "AskUserQuestion",
        tool_input: { questions },
        session_id: "cse_a",
        permission_mode: "default",
      },
      () => ({ behavior: "allow", updatedInput: { questions, answers } }),
    );
    // claude REPLACES the tool input with this updatedInput → it proceeds with the viewer's answers,
    // skipping the in-pane picker. The questions are echoed so its tool call() gets {questions, answers}.
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { questions, answers },
      },
    });
  });

  it("does NOT emit updatedInput for a NON-AskUserQuestion tool even if the decision file carries one (#147)", async () => {
    // Guard: a crafted/stray `answers` on a Bash gate must never clobber Bash's real input. The helper
    // gates updatedInput by the tool it fired for, so it drops it here even though the decision file has one.
    const { stdout } = await runHelper(
      { tool_use_id: "tu_bash", tool_name: "Bash", tool_input: { command: "ls" } },
      () => ({ behavior: "allow", updatedInput: { answers: { hijack: "x" } } }),
    );
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  it("emit() guard: a RAW deny file that DOES carry updatedInput still emits no updatedInput (helper's own last line)", async () => {
    // Feed a raw decision the driver would never write (decisionFileContent strips updatedInput on deny) so
    // we actually exercise the HELPER's belt-and-suspenders `behavior === "allow"` guard in emit() — a deny
    // must never carry updatedInput to claude even if the file on disk somehow does.
    const { stdout } = await runHelper(
      { tool_use_id: "tu_askq_deny", tool_name: "AskUserQuestion", tool_input: { questions: [] } },
      () => ({
        behavior: "deny",
        raw: JSON.stringify({
          behavior: "deny",
          reason: "vetoed",
          updatedInput: { answers: { q: "a" } },
        }),
      }),
    );
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "vetoed",
      },
    });
  });

  it("emits DENY (with the reason) when the decision file says deny", async () => {
    const { stdout } = await runHelper(
      { tool_use_id: "tu_live2", tool_name: "Write", tool_input: { file_path: "/x" } },
      () => ({ behavior: "deny", reason: "nope" }),
    );
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "nope",
      },
    });
  });

  it("synthesizes a stable id (used for both the request and the poll) when claude omits tool_use_id", async () => {
    const { stdout, requestLine } = await runHelper(
      { tool_name: "Bash", tool_input: { command: "echo hi" } }, // no tool_use_id
      () => ({ behavior: "allow" }),
    );
    const id = (requestLine as { toolUseId: string }).toolUseId;
    expect(id).toMatch(/^notu-\d+-\d+-[a-z0-9]+$/); // synthetic id (+random suffix) surfaced on the request line
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("allow"); // and the poll matched it
  });

  // FAIL-CLOSED regression: a torn/garbled decision file (the helper observes it mid-write) must NOT be
  // read as an ALLOW. The helper must keep polling until the content is a WELL-FORMED allow/deny — so a
  // viewer DENY can never be flipped to ALLOW by a read that raced the driver's write.
  it("ignores an empty/garbled decision file (keeps polling) and only honors a well-formed one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "permhook-fc-"));
    const helper = join(dir, "perm-hook.mjs");
    const reqSentinel = join(dir, "req.ndjson");
    await writeFile(helper, PRE_TOOL_USE_HELPER_SOURCE, "utf8");
    const child = spawn(process.execPath, [helper, reqSentinel, dir, "20"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    let closed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("close", () => {
      closed = true;
    });
    child.stdin.write(
      JSON.stringify({ tool_use_id: "tu_fc", tool_name: "Bash", tool_input: { command: "ls" } }),
    );
    child.stdin.end();

    // Wait for the request line so we know the helper is in its decision-poll loop.
    let id = "";
    for (let i = 0; i < 200 && id === ""; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const txt = await readFile(reqSentinel, "utf8").catch(() => "");
      const first = txt.split("\n").find((l) => l.trim() !== "");
      if (first) id = JSON.parse(first).toolUseId;
    }
    expect(id).toBe("tu_fc");
    const decFile = join(dir, `${id}.json`);

    // 1) An EMPTY file, then 2) a GARBLED one, then 3) a VALID-JSON-but-bad-behavior one: none may resolve.
    await writeFile(decFile, "");
    await new Promise((r) => setTimeout(r, 80));
    await writeFile(decFile, "{not json");
    await new Promise((r) => setTimeout(r, 80));
    await writeFile(decFile, JSON.stringify({ behavior: "maybe" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(stdout).toBe(""); // still polling — nothing emitted, did NOT fail open to allow
    expect(closed).toBe(false);

    // 4) A well-formed DENY finally resolves it (proving the loop was alive, just waiting for valid input).
    await writeFile(decFile, decisionFileContent("deny", "blocked"));
    await new Promise<void>((resolve) => {
      if (closed) return resolve();
      child.on("close", () => resolve());
    });
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    });
  });
});
