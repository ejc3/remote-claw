import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Prose } from "../app/page.js";

// The viewer renders assistant prose as GitHub-Flavored Markdown (react-markdown + remark-gfm). The live
// trigger: a model replied with a markdown table that the old bold+code-only renderer showed as raw `| |`
// pipes. These assert the GFM features render AND that raw HTML from the model can't inject markup.
const html = (text: string): string =>
  renderToStaticMarkup(createElement(Prose, { text, className: "assistant" }));

describe("Prose markdown rendering", () => {
  it("renders a GFM table as a real <table> (the raw-pipes regression)", () => {
    const md = "| Path | Size |\n|------|------|\n| `/usr/lib` | **11G** |\n| `/var` | **16G** |";
    const out = html(md);
    expect(out).toContain("<table>");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
    expect(out).toContain("11G");
    expect(out).not.toContain("|------|"); // the literal pipe table must NOT survive as text
  });

  it("renders bold, inline code, fenced code blocks, and lists", () => {
    expect(html("**bold**")).toContain("<strong>");
    expect(html("`code`")).toContain("<code>");
    expect(html("```\nx = 1\n```")).toContain("<pre>");
    expect(html("- a\n- b")).toMatch(/<ul>.*<li>/s);
    expect(html("1. one\n2. two")).toMatch(/<ol>.*<li>/s);
  });

  it("does NOT emit raw HTML from the model (no injection sink)", () => {
    const out = html('<img src=x onerror="alert(1)"> then <b>x</b>');
    // Raw HTML is escaped to TEXT, never parsed into live markup (no rehype-raw): no real <img>/<b> tag
    // and no live event-handler attribute — only the harmless escaped forms.
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain('onerror="'); // the live-attribute form; escaped &quot; is fine
    expect(out).toContain("&lt;img");
  });

  it("opens links in a new tab with noopener (can't navigate the viewer away)", () => {
    const out = html("[docs](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
  });
});
