import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Bubble } from "../app/page.js";

function render(
  tool: string,
  input: unknown,
  options: {
    agent?: string;
    native?: boolean;
    local?: boolean;
    resolved?: boolean;
    canGrant?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(Bubble, {
      message: {
        msgId: "file-approval",
        seq: 1,
        kind: "permission_request",
        text: JSON.stringify({
          request_id: "request-file",
          tool_name: tool,
          tool_input: input,
        }),
      },
      onGrant: async () => {},
      canGrant: options.canGrant ?? true,
      permissionsLocal: options.local ?? false,
      permissionAgent: options.agent ?? "Claude",
      nativePermissionResolution: options.native ?? true,
      hostConnected: true,
      resolved: options.resolved ? new Map([["request-file", "resolved"]]) : new Map(),
      resolvedAnswers: new Map(),
    }),
  );
}

describe("one-time native file approvals", () => {
  it("shows full path and full contents, with escaped markup and no truncated diff tail", () => {
    const content = `${"unchanged line\n".repeat(400)}<script>TAIL_SENTINEL</script>`;
    const html = render("Write", {
      nativeFile: true,
      file_path: "/tmp/a very long folder/scratch.txt",
      content,
    });
    expect(html).toContain("/tmp/a very long folder/scratch.txt");
    expect(html).toContain("&lt;script&gt;TAIL_SENTINEL&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Existing contents may be replaced");
    expect(html).toContain("Allow once");
    expect(html).toContain("Deny");
  });

  it("shows exact before/after and makes empty replacements explicit", () => {
    const html = render("Edit", {
      nativeFile: true,
      file_path: "/tmp/scratch",
      old_string: "original",
      new_string: "",
      replace_all: false,
    });
    expect(html).toContain("Before");
    expect(html).toContain("original");
    expect(html).toContain("After");
    expect(html).toContain("(empty)");
    expect(html).toContain("does not grant folder access");
    expect(render("Write", { nativeFile: true, file_path: "/tmp/scratch", content: "" })).toContain(
      "(empty)",
    );
    expect(render("Read", { nativeFile: true, file_path: "/tmp/scratch" })).toContain(
      "Read this file once",
    );
  });

  it("shows every bounded Codex patch and does not truncate the final diff lines", () => {
    const html = render(
      "Patch",
      {
        nativePatch: true,
        changes: [
          {
            path: "/tmp/update",
            operation: "update",
            diff: `${" context\n".repeat(400)}-before\n+TAIL_SENTINEL`,
          },
          { path: "/tmp/new", operation: "add", diff: "" },
          { path: "/tmp/deleted", operation: "delete", diff: "-old" },
        ],
      },
      { agent: "Codex" },
    );
    for (const text of [
      "/tmp/update",
      "/tmp/new",
      "/tmp/deleted",
      "Update file",
      "Create file",
      "Delete file",
      "TAIL_SENTINEL",
      "(empty diff)",
      "Allow once",
      "No directory access",
    ])
      expect(html).toContain(text);
  });

  it("keeps malformed or foreign native projections out of generic Allow/Deny", () => {
    const valid = { nativeFile: true, file_path: "/tmp/scratch" };
    for (const [tool, input, options] of [
      ["Read", { ...valid, offset: 1 }, {}],
      ["Read", { ...valid, nativeFile: false }, {}],
      ["Read", valid, { native: false }],
      ["Read", valid, { agent: "Codex" }],
      ["Edit", { ...valid, old_string: "a", new_string: "b", replace_all: true }, {}],
      ["Write", { ...valid, content: "🔥".repeat(8192) }, {}],
      ["Patch", { nativePatch: true, changes: [] }, { agent: "Codex" }],
      [
        "Patch",
        {
          nativePatch: true,
          changes: [{ path: "/tmp/a", operation: "update", diff: "+a" }],
          grantRoot: "/tmp",
        },
        { agent: "Codex" },
      ],
      [
        "Patch",
        { nativePatch: true, changes: [{ path: "/tmp/a", operation: "update", diff: "+a" }] },
        { agent: "Claude" },
      ],
    ] as const) {
      const html = render(tool, input, options);
      expect(html).toContain("File approval unavailable here");
      expect(html).not.toContain("<button");
    }
  });

  it("keeps local-only, read-only and native-resolved rows non-actionable across reload", () => {
    const input = { nativeFile: true, file_path: "/tmp/scratch" };
    expect(render("Read", input, { local: true })).not.toContain("<button");
    const resolved = render("Read", input, { resolved: true });
    expect(resolved).toContain("Resolved by Claude");
    expect(resolved).not.toContain("<button");
    const readonly = render("Read", input, { canGrant: false });
    expect(readonly.match(/<button[^>]*disabled/g)).toHaveLength(2);
  });
});
