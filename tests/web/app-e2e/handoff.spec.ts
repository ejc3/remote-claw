import { parsePass, toHex } from "@remote-claw/clawsec";
import { uploadHandoff } from "@remote-claw/cli";
import { expect, test } from "./fixtures";

// End-to-end proof of the ephemeral one-time-handoff PAIRING flow (docs/ephemeral-handoff.md) across the
// WHOLE real spine — no mocking on the handoff path:
//   host: uploadHandoff() (@remote-claw/cli) mints an OTK, seals the forever viewer-pass under it, and PUTs
//         the sealed box to the running server's REAL /api/handoff (real route → real HandoffStore → real
//         libSQL file), returning the `<origin>/#otk1_<OTK>` deep link.
//   viewer: a real Chromium opens that link → page.tsx reads the #otk1_ fragment → Pairing claims it via
//         claimHandoff() (POST /api/handoff) → the broker atomically returns-and-burns the row → the viewer
//         opens the box with the OTK and recovers the pass.
//   one-time: a SECOND claim of the same link gets a uniform 404 → the user-facing "already used or has
//         expired" message.
// The crypto, the /api/handoff route, and the store are all REAL; only the worker/model leg (seedHost's
// scripted RC turn) is canned, exactly as in transcript.spec.ts.

test("host upload → scan deep link → pair recovers the pass → connects to the live session", async ({
  page,
  seedHost,
  baseURL,
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  // A REAL host + viewer pass for a live session, so the recovered pass is a genuinely working credential.
  const { pass } = await seedHost();
  const idHex = toHex((await parsePass(pass)).identityId);

  // REAL host upload: the box is sealed under the OTK and PUT to the running server's /api/handoff. The
  // broker only ever stores one-way hashes + an opaque blob; the OTK rides the returned URL #fragment.
  const link = await uploadHandoff(baseURL, pass);
  expect(link.startsWith(`${baseURL}/#otk1_`)).toBe(true);

  // Open the deep link as a phone would. page.tsx classifies #otk1_… as a one-time handoff and DEFERS the
  // claim to a tap (so a prefetch/unfurler that runs JS can't burn it) — the Pairing screen, not a connect.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Pair this device" })).toBeVisible();

  // Tap to claim: claimHandoff POSTs id+proof → the broker returns-and-burns the sealed box → the viewer
  // opens it LOCALLY with the OTK and recovers the FOREVER pass. The revealed identity_id (recomputed in
  // the browser from the recovered pass) must equal the host's — proof the exact pass round-tripped.
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByTestId("identity-hex").filter({ hasText: idHex })).toBeVisible();

  // Confirm + connect with the recovered pass → it lands on the live session list (a real, usable creds).
  await page.getByRole("button", { name: "Connect" }).click();
  const row = page.locator("button.row", { hasText: "rc box" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-state", "connected");
});

test("the one-time link burns: a second claim shows already-used", async ({
  page,
  seedHost,
  baseURL,
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  const { pass } = await seedHost();
  const link = await uploadHandoff(baseURL, pass);

  // First claim succeeds: the row is returned-and-burned and the pass is recovered (the confirm/Connect
  // step appears only after a successful claim).
  await page.goto(link);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();

  // A SECOND device scans the SAME link — a fresh page, so it's a real fresh document load. (Re-goto'ing
  // the hash on the SAME page would be a same-document nav that keeps the already-revealed Pairing state,
  // not a re-scan.) The row is already burned, so the claim POST gets a uniform 404 and the viewer
  // surfaces the user-facing used/expired message — proving exactly-once handoff.
  const page2 = await page.context().newPage();
  await page2.goto(link);
  await page2.getByRole("button", { name: "Pair this device" }).click();
  await expect(page2.getByText(/already used or has expired/i)).toBeVisible();
  await page2.close();
});
