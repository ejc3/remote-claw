// Human-like headless verification of a LIVE remote-claw session through the REAL web viewer.
// Mode-agnostic: a driver (mitm-accountless / tmux / opencode) is launched separately and bridged to the
// local broker; this script opens the viewer in headless Chromium, connects with the session pass, sends
// a prompt like a human, and asserts a real assistant reply containing a unique needle comes back —
// then screenshots it. Lives in tests/web/ so `@playwright/test` resolves (see CLAUDE.md).
//
// Usage: node cross-mode-verify.mjs <baseUrl> <pass> <prompt> <needle> <screenshotPath> [label]
import { chromium } from "@playwright/test";

const [, , base, pass, prompt, needle, shot, label = "mode"] = process.argv;
if (!base || !pass || !prompt || !needle || !shot) {
	console.error(
		"usage: cross-mode-verify.mjs <base> <pass> <prompt> <needle> <shot> [label]",
	);
	process.exit(2);
}

const log = (m) => console.log(`[verify:${label}] ${m}`);
const browser = await chromium.launch();
let ok = false;
try {
	const page = await browser.newPage({
		viewport: { width: 1100, height: 1400 },
	});
	page.on("pageerror", (e) => log(`pageerror: ${e.message}`));

	log(`open viewer ${base}`);
	await page.goto(base, { waitUntil: "domcontentloaded" });

	// Human-like connect: type the pass into the field, then click Connect (the button is disabled until
	// the field is non-empty, so filling explicitly is more robust than racing the #fragment prefill).
	const field = page.locator("textarea.field");
	await field.waitFor({ state: "visible", timeout: 20_000 });
	await field.fill(pass);
	const connect = page.getByRole("button", { name: "Connect" });
	await connect.click();
	log("filled pass + clicked Connect");

	// The session row appears once the host's announce lands on the bus. Prefer a CONNECTED (online) row
	// — stale "reconnecting" rows from prior runs on the same identity can linger in an ephemeral backend,
	// and clicking a dead one sends the prompt nowhere. Fall back to the first row if none is connected yet.
	const online = page.locator('button.row[data-state="connected"]').first();
	const anyRow = page.locator("button.row").first();
	let row = online;
	try {
		await online.waitFor({ state: "visible", timeout: 45_000 });
	} catch {
		await anyRow.waitFor({ state: "visible", timeout: 5_000 });
		row = anyRow; // no connected row appeared — fall back to whatever is there
	}
	log(`session row visible (state=${await row.getAttribute("data-state")}) → click`);
	await row.click();

	// Compose + send like a human.
	const composer = page.getByPlaceholder(/Send a prompt/);
	await composer.waitFor({ state: "visible", timeout: 30_000 });
	await composer.fill(prompt);
	log(`sent prompt: ${JSON.stringify(prompt)}`);
	await page.getByRole("button", { name: "Send", exact: true }).click();

	// Real LLM round-trip (Bedrock) — allow generous time for the assistant reply to carry the needle.
	log(`awaiting assistant reply containing "${needle}" …`);
	await page
		.locator(".prose.assistant", { hasText: needle })
		.first()
		.waitFor({ state: "visible", timeout: 180_000 });
	log("✓ assistant reply with needle is visible");

	await page.screenshot({ path: shot, fullPage: true });
	log(`screenshot → ${shot}`);
	// Only declare success AFTER the screenshot artifact is written — a failed screenshot must not pass.
	ok = true;
} catch (e) {
	log(`FAIL: ${e?.message ?? e}`);
	try {
		const pages = browser.contexts().flatMap((c) => c.pages());
		const page = pages[0];
		if (page) {
			await page.screenshot({ path: `${shot}.fail.png`, fullPage: true });
			const txt = await page.evaluate(
				() => document.body?.innerText?.slice(0, 1200) ?? "",
			);
			log(`page text on fail:\n${txt}`);
			log(`rows seen: ${await page.locator("button.row").count()}`);
		}
	} catch (d) {
		log(`diag failed: ${d?.message ?? d}`);
	}
} finally {
	await browser.close();
}
process.exit(ok ? 0 : 1);
