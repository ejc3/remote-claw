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
// On a Vercel preview the seed route is reached with the DEV_SEED_TOKEN secret (locally it's loopback-
// gated and needs no token).
const SEED_TOKEN = process.env.E2E_SEED_TOKEN;
const seedOpts = SEED_TOKEN ? { headers: { "x-dev-seed-token": SEED_TOKEN } } : {};

test("renders a full RC turn: tool Output, sub-agent Task nesting, errors, and prose", async ({
  page,
  request,
}) => {
  // Seed the host side (real HostRcRelay + scripted turn) through the selected broker backend.
  const res = await request.post(`/api/dev/seed${qp}`, seedOpts);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };

  // Open the app with the pass in the URL fragment (never sent to the server), then connect.
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();

  // The host's bus announce surfaces the session; a fresh announce reads as connected (#58).
  const row = page.locator("button.row", { hasText: "rc box" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-state", "connected");
  // The git chip reflects the announce's git snapshot — branch + ahead count (#49).
  await expect(row.locator(".git-chip")).toContainText("main");
  await expect(row.locator(".git-chip")).toContainText("↑2");
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

  // On the Temporal run, PROVE the frames really went through Temporal (not a silent fall-back to the
  // server's default local backend): a relayChannel workflow must exist on the cluster. Use the
  // Temporal CLI (the same binary with-temporal.sh located, passed as TEMPORAL_CLI) so the test needs
  // no @temporalio/client dependency of its own.
  if (BACKEND === "temporal") {
    const { execFileSync } = await import("node:child_process");
    const cli = process.env.TEMPORAL_CLI ?? "temporal";
    const addr = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
    const out = execFileSync(
      cli,
      ["workflow", "list", "--address", addr, "--query", 'WorkflowType = "relayChannel"', "-o", "json"],
      { encoding: "utf8" },
    );
    const rows = JSON.parse(out || "[]");
    expect(Array.isArray(rows) ? rows.length : 0).toBeGreaterThan(0);
  }
});

test("a typed prompt appears as a user turn (the inbound echo path)", async ({ page, request }) => {
  const res = await request.post(`/api/dev/seed${qp}`, seedOpts);
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

test("a slash command renders as a command chip, not a chat pill (#41)", async ({ page, request }) => {
  const res = await request.post(`/api/dev/seed${qp}`, seedOpts);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // /compact rides the same user path; the echo must render as a .cmd-chip, not a chat pill.
  await page.getByPlaceholder(/Send a prompt/).fill("/compact");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".cmd-chip", { hasText: "/compact" })).toBeVisible();
  await expect(page.locator(".row-user .pill", { hasText: "/compact" })).toHaveCount(0);
});

test("the pass survives a browser refresh (it's restored from sessionStorage, not lost)", async ({
  page,
  request,
}) => {
  const res = await request.post(`/api/dev/seed${qp}`, seedOpts);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };
  // Open via the #fragment and connect — page.tsx strips the fragment from the URL after reading it.
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();

  // Reload: the fragment is already gone, so before the fix the pass was lost and the input was empty.
  // Now it must be restored from sessionStorage so the user can reconnect without re-pasting.
  await page.reload();
  await expect(page.getByPlaceholder(/rcp1_/)).toHaveValue(pass);
});

test("a granted permission stays resolved after a reload — no re-prompt (#56/#57)", async ({
  page,
  request,
}) => {
  // Seed WITH a permission card (perm=1). The optional backend switch coexists on the query string.
  const permQp = `?perm=1${BACKEND ? `&backend=${BACKEND}` : ""}`;
  const res = await request.post(`/api/dev/seed${permQp}`, seedOpts);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };

  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // The permission card renders with live Allow/Deny; grant it → the row flips to "✓ Allowed".
  const perm = page.locator(".perm", { hasText: "Bash" });
  await expect(perm.getByRole("button", { name: "Allow" })).toBeVisible();
  await perm.getByRole("button", { name: "Allow" }).click();
  await expect(perm.locator(".perm-resolved")).toHaveText(/Allowed/);
  await page
    .locator("section.chat")
    .screenshot({ path: "test-results/permission-resolved-e2e.png" });

  // Reload → reconnect (pass restored from sessionStorage) → reopen the session.
  await page.reload();
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // The host replayed the LOGGED permission_resolved on catch_up, so the card renders resolved with
  // NO live buttons. Before #56 the decision was local-only and the Allow/Deny buttons came back.
  const permAfter = page.locator(".perm", { hasText: "Bash" });
  await expect(permAfter.locator(".perm-resolved")).toHaveText(/Allowed/);
  await expect(permAfter.getByRole("button", { name: "Allow" })).toHaveCount(0);
});

test("an AskUserQuestion renders a question UI and submits answers (#42)", async ({
  page,
  request,
}) => {
  const askqQp = `?askq=1${BACKEND ? `&backend=${BACKEND}` : ""}`;
  const res = await request.post(`/api/dev/seed${askqQp}`, seedOpts);
  expect(res.ok()).toBeTruthy();
  const { pass } = (await res.json()) as { pass: string };
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // The AskUserQuestion renders as a question card (options), not a bare Allow/Deny.
  const card = page.locator(".perm.perm-q");
  await expect(card.locator(".q-text", { hasText: "Which name do you like best?" })).toBeVisible();
  const submit = card.getByRole("button", { name: "Submit answers" });
  await expect(submit).toBeDisabled(); // can't submit until a choice is picked
  await card.getByRole("button", { name: "Orion" }).click();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(card.locator(".perm-resolved")).toHaveText(/Answered/);
  await page.locator("section.chat").screenshot({ path: "test-results/askuserquestion-e2e.png" });
});
