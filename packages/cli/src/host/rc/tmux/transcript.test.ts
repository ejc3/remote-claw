// Transcript-capture tests: the pure reshape (slug / projectDir / transcriptToPayload), the byte-offset
// tailer (whole/partial/truncation), and findNewestTranscript's mtime selection. Side effects (fs) use
// a real temp dir; the reshape is fed REAL captured lines so the byte-compat claim is grounded.

import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assistantText } from "../session.js";
import {
  findNewestTranscript,
  inodeKey,
  listSubagentFiles,
  projectDir,
  projectSlug,
  readAgentTaskId,
  snapshotTranscriptInodes,
  splitLines,
  subagentDir,
  TranscriptTailer,
  transcriptPath,
  transcriptToPayload,
} from "./transcript.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rc-transcript-"));
  dirs.push(d);
  return d;
}

describe("projectSlug / projectDir / transcriptPath", () => {
  it("replaces every / and . with - (verified vs real ~/.claude/projects)", () => {
    expect(projectSlug("/home/ubuntu/remote-claw")).toBe("-home-ubuntu-remote-claw");
    expect(projectSlug("/home/ubuntu/rc-traces/edge-a-cwd")).toBe(
      "-home-ubuntu-rc-traces-edge-a-cwd",
    );
    // A cwd with a dotted dir name (e.g. a worktree under .claude) — every dot becomes a dash too.
    expect(projectSlug("/a/.claude/worktrees/x.y")).toBe("-a--claude-worktrees-x-y");
  });
  it("composes the project dir + per-session path under a given home", () => {
    expect(projectDir("/home/u/proj", "/HOME")).toBe("/HOME/.claude/projects/-home-u-proj");
    expect(transcriptPath("/home/u/proj", "cse_abc", "/HOME")).toBe(
      "/HOME/.claude/projects/-home-u-proj/cse_abc.jsonl",
    );
  });
});

describe("transcriptToPayload — the one reshape", () => {
  it("keeps a real assistant TEXT line, content blocks unchanged (relay-compatible)", () => {
    // A reduced REAL line (claude 2.1.x): the message.content text block is byte-identical to what the
    // relay's assistantText/mapUpstreamItems destructures.
    const line = JSON.stringify({
      type: "assistant",
      uuid: "ab33a7a9-22e2-49ce-9d5a-70e1b398a1b7",
      cwd: "/home/ubuntu/remote-claw",
      gitBranch: "main",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here's where things stand:" }],
      },
    });
    const p = transcriptToPayload(line);
    expect(p).not.toBeNull();
    expect(p?.type).toBe("assistant");
    expect(p?.uuid).toBe("ab33a7a9-22e2-49ce-9d5a-70e1b398a1b7");
    // content passed through verbatim → the relay's text extractor reads it.
    expect(assistantText(p as Record<string, unknown>)).toBe("Here's where things stand:");
  });

  it("keeps a tool_use assistant line (name/input/id pass through)", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      },
    });
    const p = transcriptToPayload(line);
    const blocks = (p?.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  it("keeps a user tool_result line (tool_use_id/content/is_error pass through)", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file.txt\n", is_error: false },
        ],
      },
    });
    const p = transcriptToPayload(line);
    expect(p?.type).toBe("user");
    const blocks = (p?.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]?.tool_use_id).toBe("toolu_1");
    expect(blocks[0]?.is_error).toBe(false);
  });

  it("renames parentToolUseID → parent_tool_use_id (the ONLY rename)", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u3",
      parentToolUseID: "toolu_parent",
      message: { role: "assistant", content: [{ type: "text", text: "sub" }] },
    });
    const p = transcriptToPayload(line);
    expect(p?.parent_tool_use_id).toBe("toolu_parent");
    expect((p as Record<string, unknown>).parentToolUseID).toBeUndefined();
  });

  it("passes through system task_* lifecycle fields", () => {
    const line = JSON.stringify({
      type: "system",
      uuid: "u4",
      subtype: "task_started",
      task_id: "t1",
      description: "do a thing",
      tool_use_id: "toolu_task",
    });
    const p = transcriptToPayload(line);
    expect(p?.type).toBe("system");
    expect(p?.subtype).toBe("task_started");
    expect(p?.task_id).toBe("t1");
    expect(p?.description).toBe("do a thing");
    expect(p?.tool_use_id).toBe("toolu_task");
  });

  it("drops every non-rendered type → null", () => {
    for (const type of [
      "progress",
      "pr-link",
      "bridge-session",
      "ai-title",
      "mode",
      "permission-mode",
      "attachment",
      "file-history-snapshot",
      "queue-operation",
      "agent-name",
    ]) {
      expect(transcriptToPayload(JSON.stringify({ type, uuid: "x" }))).toBeNull();
    }
  });

  it("drops blank lines and unparseable JSON → null", () => {
    expect(transcriptToPayload("")).toBeNull();
    expect(transcriptToPayload("   ")).toBeNull();
    expect(transcriptToPayload("{not json")).toBeNull();
    expect(transcriptToPayload("42")).toBeNull(); // valid JSON, not an object
    expect(transcriptToPayload("null")).toBeNull();
  });

  it("reshapes a real SUB-AGENT file line (assistant, isSidechain) like a normal assistant line", () => {
    // A sub-agent file line carries agentId/isSidechain but the SAME message envelope; the driver
    // overlays parent_tool_use_id from the .meta.json (not present on the line itself).
    const line = JSON.stringify({
      type: "assistant",
      uuid: "sub-asst-1",
      agentId: "acca154f08974f322",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "sub-agent says hi" }] },
    });
    const p = transcriptToPayload(line);
    expect(p?.type).toBe("assistant");
    expect(p?.uuid).toBe("sub-asst-1");
    expect((p?.message?.content as Array<{ text?: string }>)[0]?.text).toBe("sub-agent says hi");
  });
});

describe("splitLines — partial-line buffering", () => {
  it("emits complete lines and buffers the trailing partial", () => {
    const a = splitLines("", "line1\nline2\npar");
    expect(a.lines).toEqual(["line1", "line2"]);
    expect(a.rest).toBe("par");
    // next chunk continues the partial
    const b = splitLines(a.rest, "tial\nline4\n");
    expect(b.lines).toEqual(["partial", "line4"]);
    expect(b.rest).toBe("");
  });
});

describe("TranscriptTailer", () => {
  it("reads appended complete lines and buffers a partial across polls", async () => {
    const dir = tmp();
    const path = join(dir, "t.jsonl");
    await writeFile(path, "");
    const tail = new TranscriptTailer(path);
    expect(await tail.poll()).toEqual([]); // empty file

    await appendFile(path, '{"a":1}\n{"b":2}\n{"c":');
    expect(await tail.poll()).toEqual(['{"a":1}', '{"b":2}']); // the partial {"c": is held

    await appendFile(path, "3}\n");
    expect(await tail.poll()).toEqual(['{"c":3}']); // partial completed
    expect(await tail.poll()).toEqual([]); // nothing new
  });

  it("resets to the top on truncation (file shrank)", async () => {
    const dir = tmp();
    const path = join(dir, "t.jsonl");
    await writeFile(path, "old1\nold2\n");
    const tail = new TranscriptTailer(path);
    expect(await tail.poll()).toEqual(["old1", "old2"]);

    await truncate(path, 0);
    await writeFile(path, "new1\n");
    expect(await tail.poll()).toEqual(["new1"]); // re-read from offset 0 after the shrink
  });

  it("returns [] when the file does not exist yet", async () => {
    const tail = new TranscriptTailer(join(tmp(), "missing.jsonl"));
    expect(await tail.poll()).toEqual([]);
  });

  it("resets and re-reads on a same-NAME rotation (new inode) — codex #8", async () => {
    const dir = tmp();
    const path = join(dir, "rot.jsonl");
    await writeFile(path, "a1\na2\n");
    const tail = new TranscriptTailer(path);
    expect(await tail.poll()).toEqual(["a1", "a2"]);

    // Replace the file at the SAME name with SAME-or-larger size — the shrink check wouldn't fire. ext4
    // may REUSE the inode number, so identity rests on birthtime: the recreated file has a new birthtime
    // and must trigger a reset. (sleep so the new birthtime is distinct.)
    await rm(path);
    await sleep(15);
    await writeFile(path, "b1\nb2\nb3\n");
    expect(await tail.poll()).toEqual(["b1", "b2", "b3"]); // re-read from the top of the NEW file
  });
});

describe("snapshotTranscriptInodes / exclude-based discovery", () => {
  it("excludes the pre-spawn inodes and selects the fresh file", async () => {
    const dir = join(tmp(), "snap");
    await mkdir(dir, { recursive: true });
    const old = join(dir, "old.jsonl");
    await writeFile(old, "x\n");
    const exclude = await snapshotTranscriptInodes(dir); // taken BEFORE spawn
    expect(exclude.size).toBe(1);

    const base = Date.now();
    await sleep(15);
    const ours = join(dir, "ours.jsonl");
    await writeFile(ours, "");
    await appendFile(old, "still busy\n"); // old keeps its inode → stays excluded despite fresh mtime

    expect(await findNewestTranscript(dir, base, { exclude, slackMs: 5 })).toBe(ours);
  });

  it("still selects a FRESH file whose inode is in the exclude set (recycled inode) — wf#6", async () => {
    const dir = join(tmp(), "reuse");
    await mkdir(dir, { recursive: true });
    const base = Date.now();
    await sleep(15);
    // Our fresh transcript, created AFTER spawn. Simulate inode RECYCLING: a deleted pre-existing file's
    // inode lands on our fresh file, so the snapshot's exclude set contains OUR file's inode.
    const ours = join(dir, "ours.jsonl");
    await writeFile(ours, "");
    const recycled = new Set([inodeKey(await stat(ours))]);
    // Despite the inode being "excluded", the file is fresh (created >= spawn) so it must be picked.
    expect(await findNewestTranscript(dir, base, { exclude: recycled, slackMs: 5 })).toBe(ours);
  });
});

describe("findNewestTranscript", () => {
  it("returns null until the project dir exists", async () => {
    expect(await findNewestTranscript(join(tmp(), "nope"), Date.now())).toBeNull();
  });

  it("selects the .jsonl CREATED after spawn, ignoring a pre-existing busy file and non-.jsonl", async () => {
    const dir = join(tmp(), "proj");
    await mkdir(dir, { recursive: true });
    // A pre-existing session's file, created BEFORE spawn but still being appended (mtime = now).
    const preexisting = join(dir, "preexisting.jsonl");
    await writeFile(preexisting, "old\n");
    await sleep(15); // ensure a distinct creation time

    const base = Date.now();
    await sleep(15);
    // Our launch creates its transcript AFTER spawn.
    const ours = join(dir, "ours.jsonl");
    await writeFile(ours, "");
    const notJsonl = join(dir, "ours.txt");
    await writeFile(notJsonl, "");

    // Keep appending the pre-existing file so its MTIME is the newest — discovery must STILL pick ours
    // because it gates on CREATION time, not mtime (the shared-projects-dir robustness fix).
    await appendFile(preexisting, "more\n");

    const found = await findNewestTranscript(dir, base, { slackMs: 5 });
    expect(found).toBe(ours);
  });

  it("returns null when only a pre-existing (created-before-spawn) file is present", async () => {
    const dir = join(tmp(), "proj2");
    await mkdir(dir, { recursive: true });
    const stale = join(dir, "stale.jsonl");
    await writeFile(stale, "");
    await sleep(15);
    const base = Date.now(); // spawn happens AFTER the stale file was created
    await appendFile(stale, "still being written\n"); // mtime is fresh, but birthtime predates spawn
    expect(await findNewestTranscript(dir, base, { slackMs: 5 })).toBeNull();
  });
});

describe("subagents/: subagentDir / listSubagentFiles / readAgentTaskId", () => {
  it("derives the sibling subagents/ dir from a transcript path", () => {
    expect(subagentDir("/home/u/.claude/projects/-p/abc123.jsonl")).toBe(
      "/home/u/.claude/projects/-p/abc123/subagents",
    );
  });

  it("lists only agent-*.jsonl (not .meta.json) as full paths; [] when the dir is absent", async () => {
    const dir = join(tmp(), "sub");
    expect(await listSubagentFiles(dir)).toEqual([]); // dir doesn't exist yet (no sub-agent spawned)
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "agent-aaa.jsonl"), "");
    await writeFile(join(dir, "agent-aaa.meta.json"), "{}");
    await writeFile(join(dir, "agent-bbb.jsonl"), "");
    await writeFile(join(dir, "notes.jsonl"), ""); // not an agent file
    const found = await listSubagentFiles(dir);
    expect(found.sort()).toEqual([join(dir, "agent-aaa.jsonl"), join(dir, "agent-bbb.jsonl")]);
  });

  it("reads the spawning Agent's toolUseId from the sibling .meta.json (null if absent/bad)", async () => {
    const dir = join(tmp(), "meta");
    await mkdir(dir, { recursive: true });
    const agent = join(dir, "agent-acca.jsonl");
    expect(await readAgentTaskId(agent)).toBeNull(); // no sidecar yet
    await writeFile(
      join(dir, "agent-acca.meta.json"),
      JSON.stringify({ agentType: "general-purpose", description: "x", toolUseId: "toolu_TASK" }),
    );
    expect(await readAgentTaskId(agent)).toBe("toolu_TASK");
    // a sidecar lacking toolUseId → null (we won't surface a sub-agent line we can't nest)
    await writeFile(join(dir, "agent-acca.meta.json"), JSON.stringify({ description: "no link" }));
    expect(await readAgentTaskId(agent)).toBeNull();
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
