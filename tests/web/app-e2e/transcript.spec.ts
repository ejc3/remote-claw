import { expect, test } from "@playwright/test";

// Proves the web UI works end to end against the WHOLE real spine (only the model is scripted):
//   real Chromium → real Next client (page.tsx) → real broker routes → real HostRcRelay event mapping
//   → a Session fed a scripted RC turn.
// The /api/dev/seed route stands up the host side and returns a viewer pass; the browser drives the
// rest exactly as a phone would. Assertions target the actual rendered DOM, so a regression in the
// relay's frame mapping OR the transcript components fails the test.
//
// E2E_BACKEND (set by app-e2e.temporal.config.ts) flips the broker via the ?backend= switch so the
// IDENTICAL assertions run against both the in-process LocalBackend (default) and Temporal — proving
// the abstraction is swappable per-request on one deployment.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

test("renders a full RC turn: tool Output, sub-agent Task nesting, errors, and prose", async ({
  page,
  request,
}) => {
  // Seed the host side (real HostRcRelay + scripted turn) through the selected broker backend.
  const res = await request.post(`/api/dev/seed${qp}`);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };

  // Open the app with the pass in the URL fragment (never sent to the server), then connect.
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();

  // The host's bus announce surfaces the session; open it.
  const row = page.locator("button.row", { hasText: "rc box" });
  await expect(row).toBeVisible();
  await row.click();

  // (1) The top-level tool's Output — the tool_result the relay used to drop (#47). Target it by
  // identity (not sub, not error) so a frame-ordering regression can't make .first() grab another row.
  const output = page.locator('details.tool-result[data-sub="false"][data-error="false"]');
  await expect(output).toHaveCount(1);
  await output.click(); // expand
  await expect(output.locator("pre.tool-output")).toContainText("built in 3.42s");

  // (2) The sub-agent Task lifecycle row — the sub-agent is now visible (#47).
  await expect(page.locator(".task-row", { hasText: "Task started" })).toBeVisible();

  // (3) The sub-agent's Output nests under the Task (the data-sub fix), surviving its null content
  //     block (the codex crash guard) — there is exactly one sub-tagged tool_result.
  await expect(page.locator('details.tool-result[data-sub="true"]')).toHaveCount(1);
  await expect(page.locator('details.tool-result[data-sub="true"]')).toContainText(
    "no flake reproduced",
  );

  // (4) An error tool_result renders red (data-error).
  await expect(page.locator('details.tool-result[data-error="true"]')).toBeVisible();

  // (5) The model's prose (Prose renders a div.prose.assistant).
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();

  // Artifact: the real transcript as rendered by the real app.
  await page.locator("section.chat").screenshot({ path: "test-results/transcript-e2e.png" });
});

test("a typed prompt appears as a user turn (the inbound echo path)", async ({ page, request }) => {
  const res = await request.post(`/api/dev/seed${qp}`);
  expect(res.ok()).toBeTruthy(); // a 404 (server not in local mode) would otherwise fail confusingly
  const { pass } = (await res.json()) as { pass: string };
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // Type into the composer and send; the relay acks + echoes it back as a user pill on every device.
  await page.getByPlaceholder(/Send a prompt/).fill("ship it");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".row-user .pill", { hasText: "ship it" })).toBeVisible();
});
