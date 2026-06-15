import { expect, test } from "./fixtures";

// Proves the web UI works end to end against the WHOLE real spine (only the worker/model is scripted):
//   real Chromium → real Next client (page.tsx) → real broker routes → real HostRcRelay event mapping
//   → a Session fed a scripted RC turn.
// `seedHost(opts)` (fixtures.ts) stands up the host as a REAL persistent process (tsx host-runner) pointed
// at the broker the browser uses, returns a viewer pass, and the browser drives the rest exactly as a
// phone would — including LIVE round-trips (typed prompt, permission grant, AskUserQuestion answer,
// attachment), which the persistent host echoes back. Assertions target the actual rendered DOM, so a
// regression in the relay's frame mapping OR the transcript components fails the test.
//
// E2E_BACKEND (set by app-e2e.sqlite.config.ts) flips the broker via the ?backend= switch for the
// browser AND the host (the fixture forwards it), so the IDENTICAL assertions run against LocalBackend
// (default) or per-session SQLite/Turso — proving the abstraction is swappable per-request.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

test("renders a full RC turn: tool Output, sub-agent Task nesting, errors, and prose", async ({
  page,
  seedHost,
}) => {
  // Seed the host side (real HostRcRelay + scripted turn) through the selected broker backend.
  const { pass } = await seedHost();

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
});

test("a typed prompt appears as a user turn (the inbound echo path)", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // Type into the composer and send; the host acks + echoes it back as a user pill on every device.
  await page.getByPlaceholder(/Send a prompt/).fill("ship it");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".row-user .pill", { hasText: "ship it" })).toBeVisible();
});

test("a slash command renders as a command chip, not a chat pill (#41)", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // /compact rides the same user path; the echo must render as a .cmd-chip, not a chat pill.
  await page.getByPlaceholder(/Send a prompt/).fill("/compact");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".cmd-chip", { hasText: "/compact" })).toBeVisible();
  await expect(page.locator(".row-user .pill", { hasText: "/compact" })).toHaveCount(0);
});

test("the session AUTO-reconnects after a browser refresh (credential restored, no re-paste)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  // Open via the #fragment and connect — page.tsx strips the fragment from the URL after reading it.
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();

  // Reload: the fragment is gone, so the app restores the stored credential (§3.6) and AUTO-reconnects
  // — it must land back on the session list, NOT the pass/token form (#110).
  await page.reload();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();
  await expect(page.getByPlaceholder(/rcp1_/)).toHaveCount(0); // never re-shows the token form on reload
});

test("a granted permission stays resolved after a reload — no re-prompt (#56/#57)", async ({
  page,
  seedHost,
}) => {
  // Seed WITH a permission card (perm), driven through the selected backend.
  const { pass } = await seedHost({ perm: true });

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

  // Reload → the stored credential AUTO-reconnects (no re-paste, #110) → reopen the session.
  await page.reload();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // The host replayed the LOGGED permission_resolved on catch_up, so the card renders resolved with
  // NO live buttons. Before #56 the decision was local-only and the Allow/Deny buttons came back.
  const permAfter = page.locator(".perm", { hasText: "Bash" });
  await expect(permAfter.locator(".perm-resolved")).toHaveText(/Allowed/);
  await expect(permAfter.getByRole("button", { name: "Allow" })).toHaveCount(0);
});

test("an AskUserQuestion renders a question UI and submits answers (#42)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost({ askq: true });
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

test("attaching a photo sends it and echoes in the transcript (#44)", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();

  // A real (tiny 4x4) PNG so the browser's canvas downscale can decode it.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4YWMDRwzEcQAREhQBbrqBkwAAAABJRU5ErkJggg==",
    "base64",
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });

  // The host wrote the file + echoed a user frame with the attachment chip (proves the full inbound
  // attachment path: viewer downscale → E2E frame → relay write + inject + echo → transcript).
  await expect(page.locator(".row-user .pill", { hasText: "📎 photo.png" })).toBeVisible();
  await page.locator("section.chat").screenshot({ path: "test-results/attachment-e2e.png" });
});

test("serves the CSP + security headers, and the app still hydrates under them (#2)", async ({
  page,
}) => {
  // Asserted against the PRODUCTION build (next start), so this is the enforced prod policy — and the
  // fact that every other test in this file connects, renders, and attaches under it proves the CSP
  // doesn't break hydration.
  const resp = await page.goto(`/${qp}`);
  const h = resp?.headers() ?? {};
  const csp = h["content-security-policy"] ?? "";
  // The exfiltration-blocking directives — the pass can't be fetched/beaconed/POSTed to another origin,
  // no external script origins, no base-uri hijack, no object/embed, no framing.
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'"); // no external script origins
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("img-src 'self' blob: data:");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  // Static defense-in-depth headers from next.config.
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["strict-transport-security"]).toContain("max-age=");
  // The page still loads + is interactive under the CSP (no blocked framework script).
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
});
