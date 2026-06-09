// Tests for the tracing-passthrough MITM (`--rc-trace`): the pure RC-frame parsing helpers, plus the
// run-mode env wiring (a fake spawn — no real network). The passthrough→real-Anthropic tee is the
// tool's whole point and is exercised manually; here we lock down the logic that decodes what flows.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evType, parseSseBlock, rcLabel } from "./mitm.js";
import { runRcTrace } from "./trace-run.js";

function haveOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const RUN = haveOpenssl();

const cleanup: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanup) c();
});

describe("rcLabel", () => {
  it("masks the session id and labels RC endpoints", () => {
    expect(rcLabel("/v1/code/sessions")).toBe("/v1/code/sessions");
    expect(rcLabel("/v1/code/sessions/sess_abc123")).toBe("/v1/code/sessions/{id}");
    expect(rcLabel("/v1/code/sessions/sess_abc123/worker/events/stream")).toBe(
      "/v1/code/sessions/{id}/worker/events/stream",
    );
    expect(rcLabel("/v1/code/triggers")).toBe("/v1/code/triggers");
  });

  it("returns null for non-RC paths", () => {
    expect(rcLabel("/v1/messages")).toBeNull();
    expect(rcLabel("/api/claude_cli/bootstrap")).toBeNull();
  });
});

describe("evType", () => {
  it("reads payload.type, then top-level type", () => {
    expect(evType({ payload: { type: "assistant" } })).toBe("assistant");
    expect(evType({ type: "result" })).toBe("result");
  });
  it("is '?' for junk", () => {
    expect(evType(null)).toBe("?");
    expect(evType(42)).toBe("?");
    expect(evType({ nope: 1 })).toBe("?");
  });
});

describe("parseSseBlock", () => {
  it("parses event / id / data lines", () => {
    const { event, id, data } = parseSseBlock(
      'event: client_event\nid: 5\ndata: {"type":"assistant"}',
    );
    expect(event).toBe("client_event");
    expect(id).toBe("5");
    expect(evType(JSON.parse(data))).toBe("assistant");
  });
  it("concatenates multi-line data and ignores keepalive comments", () => {
    expect(parseSseBlock(":keepalive")).toEqual({ event: "", id: "", data: "" });
    const { data } = parseSseBlock('data: {"a":1,\ndata: "b":2}');
    expect(data).toBe('{"a":1,"b":2}');
  });
});

describe.skipIf(!RUN)("runRcTrace env wiring", () => {
  it("spawns claude behind the proxy with the MITM env, returning its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-trace-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const notes: string[] = [];
    let captured: NodeJS.ProcessEnv | undefined;

    const code = await runRcTrace({
      claudeArgs: ["chat"],
      certsDir: join(dir, "mitm-certs"),
      note: (s) => notes.push(s),
      spawnClaude: async (_bin, _args, env) => {
        captured = env;
        return 7;
      },
    });

    expect(code).toBe(7);
    expect(captured?.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(captured?.https_proxy).toBe(captured?.HTTPS_PROXY);
    expect(captured?.NODE_EXTRA_CA_CERTS).toContain("mitm-certs");
    // A stray NO_PROXY would make the child bypass our MITM — it must be cleared.
    expect("NO_PROXY" in (captured ?? {})).toBe(false);
    expect(notes.join("")).toContain("trace MITM → real api.anthropic.com");
  });
});
