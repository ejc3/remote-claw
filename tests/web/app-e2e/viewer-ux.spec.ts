import { expect, test } from "./fixtures";

// Regression guards for the design-pass UX fixes (PR: viewer-ux-design-pass). Each test pins a
// specific finding from the driven browser pass so a future change can't silently undo it. These run
// against the SAME real spine as transcript.spec.ts (real Chromium → Next client → broker → scripted
// host); the assertions target the actual rendered DOM / computed CSS, not a mock.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

// #design-pass: the gate is a single-field page — it must autofocus so a pasted pass lands immediately
// without a click. Caught in the pass: every connect started with an extra tab/click into the field.
test("the connect gate autofocuses its pass field", async ({ page }) => {
  await page.goto(`/${qp}`);
  await expect(page.getByLabel("Machine pass")).toBeFocused();
});

// #design-pass: the disabled primary CTA used to render as a dead grey slab indistinguishable from a
// broken button. The fix keeps the accent identity and just dims it (opacity .5) so it reads as an
// inactive primary, not a failure. Assert the COMPUTED style so a CSS regression fails here.
test("the disabled Connect CTA stays a dimmed primary, not a dead grey slab", async ({ page }) => {
  await page.goto(`/${qp}`);
  const btn = page.getByRole("button", { name: "Connect" });
  await expect(btn).toBeDisabled(); // empty pass ⇒ disabled
  const style = await btn.evaluate((el) => ({
    opacity: getComputedStyle(el).opacity,
    bg: getComputedStyle(el).backgroundColor,
  }));
  expect(style.opacity).toBe("0.5"); // dimmed, not hidden
  expect(style.bg).not.toBe("rgba(0, 0, 0, 0)"); // still carries the accent fill (not transparent)
});

// The entry screens' actions are full-width primary CTAs on a phone, so they hold the same 44px touch
// minimum this app already enforces on permission buttons. Astryx's largest Button (size="lg") is 36px
// — a considered size for the system, but below this app's floor — so viewer.css raises it. Measured on
// the migrated (Astryx) control, because the whole point is that adopting a design system must not
// quietly lower an accessibility standard the app already held: the md default rendered 32px.
test("the entry CTA meets the 44px touch target", async ({ page }) => {
  await page.goto(`/${qp}`);
  const cta = page.getByRole("button", { name: "Connect" });
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

// The keyboard focus ring must stay the BRIGHT accent (#7c7ef5 → rgb(124,126,245)). This is a live
// regression risk rather than a hypothetical: what draws it is the global :focus-visible rule in
// viewer.css, and every OTHER rule in that file is migration debt scheduled for deletion as its
// component moves to Astryx. Deleting this one along with them silently changes the indicator —
// bite-checked here, where removing the rule drops this control's outline to rgb(236,236,238) (the
// inherited text colour). Astryx's own rings would not restore it either: astryx.css draws them as
// `outline: 2px solid var(--color-accent)`, and this theme pins --color-accent to the darker #5457e8
// FILL for brand reasons (~3.4:1 on the near-black background vs 5.8:1 for #7c7ef5 — still over the 3:1
// WCAG 2.2 SC 1.4.11 asks of a non-text indicator, but visibly dimmer). Asserted on a migrated (Astryx
// TextArea) control specifically, so it covers the components the migration has already replaced.
test("keyboard focus rings stay the bright accent on Astryx controls", async ({ page }) => {
  await page.goto(`/${qp}`);
  const field = page.getByLabel("Machine pass");
  await field.focus();
  const ring = await field.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.outlineColor, width: s.outlineWidth, style: s.outlineStyle };
  });
  expect(ring.color).toBe("rgb(124, 126, 245)"); // --accent-text, NOT the #5457e8 fill
  expect(ring.style).toBe("solid");
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
});

// #design-pass (#8): the session row truncates its title/cwd to one line; the full identity (title ·
// branch · cwd) must be available as a hover tooltip so a long path isn't lost to the ellipsis.
test("the session row title carries branch + cwd as a hover tooltip", async ({ page, seedHost }) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  const row = page.locator("button.row", { hasText: "rc box" });
  await expect(row).toBeVisible();
  const title = await row.getAttribute("title");
  expect(title).toContain("rc box"); // the session title
  expect(title).toContain("main"); // the git branch from the announce
  expect(title).toContain("/home/ubuntu/remote-claw"); // the full cwd (the part the ellipsis hides)
  // The default (MITM) host announces the native-RC harness → the list badge reads "Claude Code · RC" (#164).
  await expect(row.locator(".agent-badge")).toHaveText("Claude Code · RC");
});

// #164: the session list labels WHICH agent + bridge mode each session is, so native-RC Claude Code, tmux
// Claude Code, and opencode don't look identical. The host announces its HarnessDescriptor; the badge is
// driven end-to-end from that announce (RC_E2E_HARNESS picks which the scripted host declares).
test("the session-list badge labels the harness (RC / TX / opencode) from the announce", async ({
  page,
  seedHost,
}) => {
  for (const [harness, label, agent] of [
    ["tmux", "Claude Code · TX", "claude-code"],
    ["opencode", "opencode", "opencode"],
  ] as const) {
    const { pass } = await seedHost({ harness });
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    const row = page.locator("button.row", { hasText: "rc box" });
    const badge = row.locator(".agent-badge");
    await expect(badge).toHaveText(label);
    await expect(badge).toHaveAttribute("data-agent", agent);
    await row.screenshot({ path: `test-results/agent-badge-${harness}.png` });
  }
});

// #design-pass: "Forget pass" wipes the credential and bounces to the gate — a single misclick used to
// drop a live session instantly. It is now a two-step confirm: the first tap only ARMS (relabels), and
// the session stays connected; only the second tap forgets.
test("Forget pass is a two-step confirm — one tap arms without dropping the session", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("button.row", { hasText: "rc box" })).toBeVisible();

  // First tap: ARMS (the label/aria-label flips) but does NOT forget. The armed button's presence already
  // proves we didn't bounce to the gate (the gate has no such button), so we assert that and click confirm
  // PROMPTLY — the arm auto-disarms after 4s, so we must not sit on slow intervening assertions here.
  await page.getByRole("button", { name: "Forget pass", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Confirm forget pass" });
  await expect(confirm).toHaveText("Tap again to forget"); // armed, still in the Console (not the gate)
  await confirm.click(); // second tap forgets

  // Now the credential is wiped and we land back on the connect gate.
  await expect(page.getByLabel("Machine pass")).toBeVisible();
});

// #design-pass (review follow-up): the transcript must FOLLOW to the foot when the reader is pinned there
// — a multi-frame turn (tool output + sub-agent task + error + prose) should leave the viewer scrolled to
// the bottom with no "jump to latest" pill. Guards the streaming-follow regression the smooth-scroll
// version had (intermediate scroll events latching "not at bottom"); the follow is now an instant scroll.
test("the transcript follows to the bottom on a multi-frame turn (no jump pill)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  // Wait for the turn's prose (the last visible block) to render.
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();
  // The scroller is pinned to the foot …
  const atBottom = await page
    .locator(".transcript")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 64);
  expect(atBottom).toBe(true);
  // … and no "jump to latest" pill is shown (we never left the bottom).
  await expect(page.locator(".jump-latest")).toHaveCount(0);
});

// #design-pass (a11y): the session row's connection state was conveyed by the dot's COLOR alone. The
// dot now carries an accessible name (role=img + aria-label) so AT users get the same state.
test("the connection-state dot exposes an accessible name (not color alone)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  const dot = page.locator("button.row .dot").first();
  await expect(dot).toBeVisible();
  // A freshly-seeded announce reads "online" specifically — assert the exact state, not just "some label",
  // so a bug that always rendered the wrong-but-valid state would still fail.
  await expect(dot).toHaveAttribute("aria-label", "online");
});

// #design-pass (a11y/touch): granting/denying a permission is irreversible — its buttons must meet the
// 44px minimum touch target so they aren't fat-fingered on mobile.
test("permission Allow/Deny buttons meet the 44px minimum touch target", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost({ perm: true });
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  // Measure BOTH — the test name says Allow/Deny, and the floor rule covers both, so a Deny-only
  // regression must not slip through (codex #174 false-green).
  for (const name of ["Allow", "Deny"] as const) {
    const btn = page.locator(".perm").getByRole("button", { name });
    await expect(btn).toBeVisible();
    const h = await btn.evaluate((el) => el.getBoundingClientRect().height);
    expect(h, `${name} button height`).toBeGreaterThanOrEqual(44);
  }
});

// #151 mobile a11y: pinch-zoom must not be blocked (no maximum-scale), focusable inputs are ≥16px (so
// iOS doesn't auto-zoom on focus once scale is unpinned), composer controls meet the 44px touch target,
// and on a coarse pointer Enter inserts a newline instead of sending. The default project is Pixel 5
// (a touch device → pointer: coarse), so these run in the real mobile context.
test.describe("mobile a11y (#151)", () => {
  test("the viewport allows pinch-zoom (no maximum-scale / user-scalable=no)", async ({ page }) => {
    await page.goto(`/${qp}`);
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).not.toMatch(/maximum-scale/i);
    expect(content).not.toMatch(/user-scalable\s*=\s*no/i);
  });

  test("the connect field is ≥16px (no iOS focus auto-zoom)", async ({ page }) => {
    await page.goto(`/${qp}`);
    const fs = await page
      .getByLabel("Machine pass")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fs).toBeGreaterThanOrEqual(16);
  });

  test("composer input is ≥16px and its controls meet the 44px touch target", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost();
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    const inputFs = await page
      .locator("textarea.composer-input")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(inputFs).toBeGreaterThanOrEqual(16);

    // The three composer controls are Astryx Button/IconButton now, located the way a user would
    // find them (accessible name) or by a stable test id where the label varies with the mode.
    const controls = [
      page.getByTestId("composer-mode"),
      page.getByRole("button", { name: "Attach photos" }),
      page.getByRole("button", { name: "Send", exact: true }),
    ];
    for (const c of controls) {
      const h = await c.evaluate((el) => el.getBoundingClientRect().height);
      expect(h, "composer control height").toBeGreaterThanOrEqual(44);
    }
  });

  test("on a touch device, Enter inserts a newline (does not send)", async ({ page, seedHost }) => {
    const { pass } = await seedHost();
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    const input = page.getByPlaceholder(/Send a prompt/);
    await input.click();
    await input.type("line one");
    await input.press("Enter");
    await input.type("line two");
    // Enter did NOT send — the draft is still in the composer, now multi-line, and no user pill appeared.
    await expect(input).toHaveValue("line one\nline two");
    await expect(page.locator(".row-user .pill", { hasText: "line one" })).toHaveCount(0);
  });
});

// #150 send-failure resilience: when the publish POST fails, the draft must NOT be lost. The previous
// behavior cleared the composer optimistically and left only a dead "failed to send" bubble (and the
// staged images' previews were revoked → unrecoverable). Now the draft is restored to the composer and a
// Retry is offered. We force the failure by aborting the browser's `/api/relay` POST (the publish leg).
test("a failed send restores the draft to the composer and offers Retry, then Retry succeeds", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  // Wait for the seeded turn to render first, so the subscribe + catch_up publish have already completed
  // (catch_up also rides /api/relay — we only want to fail the SEND, not the history request).
  await expect(page.locator(".prose.assistant").first()).toBeVisible();

  // Abort the publish POST so the send rejects. (All broker traffic rides /api/relay, but the abort-window
  // assertions below don't depend on the live stream — they're about the composer + banner.)
  await page.route("**/api/relay**", (route) => route.abort());

  await page.getByPlaceholder(/Send a prompt/).fill("don't lose me");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The error banner appears with a Retry, and the draft is BACK in the composer (not stranded/lost).
  await expect(page.locator(".send-err")).toContainText("Couldn’t send");
  await expect(page.locator(".send-err-retry")).toBeVisible();
  await expect(page.locator("textarea.composer-input")).toHaveValue("don't lose me");
  // No dead "failed to send" bubble was left behind (the draft moved back to the composer instead).
  await expect(page.locator(".row-user .pill", { hasText: "failed to send" })).toHaveCount(0);

  // Let the publish succeed, then Retry — the message goes through and echoes back as a user pill.
  await page.unroute("**/api/relay**");
  await page.locator(".send-err-retry").click();
  await expect(page.locator(".row-user .pill", { hasText: "don't lose me" })).toBeVisible();
  await expect(page.locator(".send-err")).toHaveCount(0); // banner cleared on the successful send
});

// The bottom-sheet has NO body scroll-lock (it would be a no-op — .transcript, not <body>, is the
// scroller). What actually stops the transcript scrolling behind an open sheet is the full-viewport
// .sheet-layer (position:fixed; inset:0; z-index:50) sitting above it — the .sheet-scrim is its visible,
// click-to-close part. This pins that mechanism: with the mode sheet open, every point over the
// transcript's rectangle must resolve to the overlay (layer/scrim/sheet), never to an element inside
// .transcript. A future change (the overlay not covering, pointer-events slip, z-index regression) would
// silently reintroduce scroll-behind — the exact bug an Astryx <Dialog> was considered for, then found
// unnecessary because the overlay already solves it (finding N; verified on Chromium + WebKit).
test("an open sheet's scrim covers the whole transcript region (the real scroll barrier)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();
  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  await expect(page.locator(".transcript")).toBeVisible();
  const box = await page.locator(".transcript").boundingBox();
  expect(box).not.toBeNull();
  await page.getByTestId("composer-mode").click();
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  // Sample the transcript's own rectangle; every point must resolve to the scrim (or the sheet), never
  // an element inside .transcript.
  const b = box!;
  const pts: Array<[number, number]> = [
    [b.x + b.width / 2, b.y + 8],
    [b.x + b.width / 2, b.y + b.height / 2],
    [b.x + b.width / 2, b.y + b.height - 8],
  ];
  const reaches = await page.evaluate(
    (points) =>
      points.map(([x, y]) => {
        let n = document.elementFromPoint(x, y);
        while (n) {
          if (
            n.classList?.contains("sheet-layer") ||
            n.classList?.contains("sheet-scrim") ||
            n.classList?.contains("sheet")
          )
            return "blocked";
          if (n.classList?.contains("transcript")) return "LEAKED";
          n = n.parentElement;
        }
        return "other";
      }),
    pts,
  );
  expect(reaches, "a touch/wheel over the transcript must hit the scrim, never the scroller").not.toContain(
    "LEAKED",
  );
});

// #149 capability-aware viewer: a driver declares (on session_announce) which controls it can
// faithfully service; the viewer disables + labels the ones it can't, so a permission-mode/model "✓"
// never lies. Drive the real spine with reduced-capability presets and assert the rendered gating.
test.describe("capability gating (#149)", () => {
  test.use({ viewport: { width: 1100, height: 900 }, isMobile: false, hasTouch: false });

  test("an opencode-skip host shows the permissions-off badge, a disabled mode button, and no model switcher", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost({ caps: "opencode-skip" });
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    // structuredPermissions:false → the "permissions off" posture badge is shown in the chat header.
    await expect(page.locator(".perms-bypassed")).toBeVisible();

    // controls.setMode:false → the composer's permission-mode button is disabled (read-only display).
    await expect(page.getByTestId("composer-mode")).toBeDisabled();

    // controls.setModel:false → the ⋯ sheet replaces the model rows with an explanatory note.
    await page.locator("button.chat-menu").click();
    const sheet = page.locator(".sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("can’t switch model");
    await expect(sheet.locator(".mode-row", { hasText: "Opus" })).toHaveCount(0);
    // interrupt:true → Interrupt is still actionable (not disabled).
    await expect(sheet.locator(".mode-row-danger")).toBeEnabled();
  });

  test("a tmux host disables set_mode but keeps the model switcher and shows no permissions-off badge", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost({ caps: "tmux" });
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    // structuredPermissions:true → no bypassed badge (tmux mirrors permission gates).
    await expect(page.locator(".perms-bypassed")).toHaveCount(0);
    // controls.setMode:false → mode button disabled …
    await expect(page.getByTestId("composer-mode")).toBeDisabled();
    // … but controls.setModel:true → the model switcher rows are present.
    await page.locator("button.chat-menu").click();
    await expect(page.locator(".sheet .mode-row", { hasText: "Opus" })).toBeVisible();
  });

  test("a default (MITM) host enables every control — mode button active, full model switcher, no badge", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost(); // no caps preset → full MITM capabilities
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    await expect(page.locator(".perms-bypassed")).toHaveCount(0);
    await expect(page.getByTestId("composer-mode")).toBeEnabled();
    await page.locator("button.chat-menu").click();
    await expect(page.locator(".sheet .mode-row", { hasText: "Opus" })).toBeVisible();
  });
});

// #design-pass (functional-1): the session ⋯ actions (model switcher / interrupt / copy-branch) were
// only reachable from the MOBILE header — on desktop the chat header was hidden, so they were
// completely unreachable. The fix shows the chat header on every viewport (carrying ⋯) and hides only
// the now-redundant in-chat back button on desktop (the sidebar already navigates).
test.describe("desktop layout (≥761px)", () => {
  // 1400px so the pane (~1120 after the sidebar) is meaningfully WIDER than the 820px reading column —
  // making the composer cap + centering and the anchored-dropdown placement observable (at ~1100 the pane
  // is itself ~820, so a full-bleed bug would be invisible).
  test.use({ viewport: { width: 1400, height: 900 }, isMobile: false, hasTouch: false });

  test("the session ⋯ actions are reachable on desktop; the redundant back button is hidden", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost();
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    // The in-chat back button is redundant on desktop (sidebar visible) → hidden.
    await expect(page.locator(".back")).toBeHidden();

    // The ⋯ menu IS reachable on desktop and opens the session-actions sheet (model + interrupt).
    const menu = page.locator("button.chat-menu");
    await expect(menu).toBeVisible();
    await menu.click();
    const sheet = page.locator(".sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Change model");
    await expect(sheet).toContainText("Interrupt");
  });

  test("the composer is capped to the reading column and centered under the transcript (not full-bleed)", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost();
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();

    const composer = page.locator(".composer-row");
    const transcript = page.locator(".transcript");
    const cb = await composer.boundingBox();
    const tb = await transcript.boundingBox();
    expect(cb).not.toBeNull();
    expect(tb).not.toBeNull();
    if (!cb || !tb) return;
    // Capped to ~820 (the reading measure), NOT the full ~1120 pane — the full-bleed bug this fixes.
    expect(cb.width).toBeLessThanOrEqual(821);
    // Centered on the SAME column as the transcript (both margin-inline:auto at max-width 820).
    const composerCenter = cb.x + cb.width / 2;
    const transcriptCenter = tb.x + tb.width / 2;
    expect(Math.abs(composerCenter - transcriptCenter)).toBeLessThan(5);
  });

  test("the ⋯ menu opens as a dropdown anchored to the trigger, not a full-width bottom sheet", async ({
    page,
    seedHost,
  }) => {
    const { pass } = await seedHost();
    await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("button.row", { hasText: "rc box" }).click();
    await page.locator("button.chat-menu").click();

    const sheet = page.locator(".sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveClass(/sheet--anchored/); // desktop dropdown, not the mobile bottom sheet
    const sb = await sheet.boundingBox();
    expect(sb).not.toBeNull();
    if (!sb) return;
    expect(sb.width).toBeLessThanOrEqual(360); // a compact popover, not full-width
    expect(sb.y).toBeLessThan(300); // anchored below the top-right ⋯, not pinned to the bottom edge
  });
});
