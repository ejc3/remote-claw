import { expect, test } from "./fixtures";

// #H double-send guard. send() mints a FRESH clientMsgId per call, so the optimistic-echo dedup can't
// absorb a double-fire — the synchronous `sendingRef` guard in send() is the SOLE protection against a
// double-tap / Enter-mash posting the SAME draft twice to the live session. This pins it: two Send clicks
// in the SAME tick fire TWO submit events (proven by the in-page counter) but produce exactly ONE user
// message — the guard collapses the second send(). Without the guard each send() mints its own clientMsgId
// → two optimistic pills → two host echoes → two pills. Verified to FAIL (count 2) when the guard is removed.
const BACKEND = process.env.E2E_BACKEND;
const qp = BACKEND ? `?backend=${BACKEND}` : "";

test("a double-tap on Send fires two submits but posts the draft once (sendingRef guard)", async ({
  page,
  seedHost,
}) => {
  const { pass } = await seedHost();

  await page.goto(`/${qp}#${encodeURIComponent(pass)}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator("button.row", { hasText: "rc box" }).click();
  await expect(page.locator(".prose.assistant", { hasText: "Build is green" })).toBeVisible();

  const text = "double tap me";
  await page.getByRole("textbox", { name: "Message" }).fill(text);

  // Fire TWO clicks in the SAME task tick — before React commits setInput("")/setSending(true), so the Send
  // button isn't yet disabled and BOTH clicks reach the form's submit handler. We COUNT the submit events
  // in-page to PROVE two send attempts actually happened: this rules out the false-green where the second
  // click is swallowed (a disabled button, a cleared input) so the single pill comes from one send, not the
  // guard. With submits===2 confirmed, exactly one pill can only mean the guard collapsed the second send().
  // (Two awaited .click()s would NOT test it: the first clears the input, so the second early-returns on
  // empty, masking a missing guard.)
  const submits = await page.locator("form.composer").evaluate((el) => {
    const form = el as HTMLFormElement;
    let n = 0;
    const count = () => {
      n += 1;
    };
    form.addEventListener("submit", count, true); // capture: runs before React's onSubmit preventDefault
    const btn = form.querySelector("button.composer-send") as HTMLButtonElement | null;
    btn?.click();
    btn?.click();
    form.removeEventListener("submit", count, true);
    return n;
  });
  expect(submits).toBe(2);

  // Settle the round-trip to a HOST-CONFIRMED solid pill (not the optimistic one). If two had been sent,
  // two would echo. Then assert exactly ONE user pill exists for this draft despite the two submits above.
  await expect(page.locator(".row-user .pill:not(.pill-pending)", { hasText: text })).toBeVisible();
  await expect(page.locator(".row-user .pill", { hasText: text })).toHaveCount(1);
});
