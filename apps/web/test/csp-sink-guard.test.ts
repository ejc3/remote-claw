import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "../app/lib/viewer.js";
import { Bubble } from "../app/page.js";

const SINK_RE =
  /dangerouslySetInnerHTML|\.innerHTML|\beval\(|new Function|document\.write|location\.(href|assign|replace)/;
const SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx"]);

function sourceRoots(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return ["../app", "../components"].map((p) => join(here, p)).filter((p) => existsSync(p));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(p));
    else if (SOURCE_EXTS.has(extname(ent.name))) out.push(p);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function msg(kind: string, text: string): Message {
  return { kind, seq: 0, text, msgId: `${kind}-xss` };
}

describe("CSP sink guard", () => {
  it("keeps app/components free of direct injection/navigation sinks", () => {
    const hits: string[] = [];
    for (const root of sourceRoots()) {
      for (const file of sourceFiles(root)) {
        const clean = stripComments(readFileSync(file, "utf8"));
        if (SINK_RE.test(clean)) hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });

  it("renders hostile transcript, tool, and permission text as inert escaped content", () => {
    const marker = "__rcSinkProbe";
    (globalThis as Record<string, unknown>)[marker] = false;
    const attacker = `<script>globalThis.${marker}=true</script><img src=x onerror="globalThis.${marker}=true"><a href="javascript:globalThis.${marker}=true">x</a>`;
    const onGrant = async () => undefined;
    const resolved = new Map<string, "allow" | "deny">();
    const resolvedAnswers = new Map<string, Record<string, string | string[]>>();

    const html = [
      renderToStaticMarkup(
        createElement(Bubble, {
          message: msg("assistant", attacker),
          onGrant,
          canGrant: true,
          permissionsLocal: false,
          hostConnected: true,
          resolved,
          resolvedAnswers,
        }),
      ),
      renderToStaticMarkup(
        createElement(Bubble, {
          message: msg(
            "tool_use",
            JSON.stringify({
              name: "Bash",
              input: { command: attacker, description: attacker },
            }),
          ),
          onGrant,
          canGrant: true,
          permissionsLocal: false,
          hostConnected: true,
          resolved,
          resolvedAnswers,
        }),
      ),
      renderToStaticMarkup(
        createElement(Bubble, {
          message: msg(
            "permission_request",
            JSON.stringify({
              request_id: "perm-xss",
              tool_name: attacker,
              tool_input: { command: attacker },
            }),
          ),
          onGrant,
          canGrant: true,
          permissionsLocal: false,
          hostConnected: true,
          resolved,
          resolvedAnswers,
        }),
      ),
    ].join("\n");

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<[^>]+\sonerror\s*=/i);
    expect(html).not.toMatch(/\shref\s*=\s*["']\s*javascript:/i);
    expect((globalThis as Record<string, unknown>)[marker]).toBe(false);
    delete (globalThis as Record<string, unknown>)[marker];
  });
});
