import {
  decodeHandoffBox,
  fromHex,
  handoffClaimProof,
  handoffId,
  openHandoff,
  parseOtk,
  toHex,
} from "@remote-claw/clawsec";

// Claim a one-time handoff (docs/ephemeral-handoff.md): POST id + proof to the same-origin /api/handoff
// claim endpoint, then open the returned sealed box LOCALLY with the OTK. The OTK never leaves the browser;
// the server only ever sees the hashes + the opaque box. Returns the resolved `rcp1_` pass. Throws a
// user-facing message on a used/expired/failed link (the row is one-time + TTL-bounded).
export async function claimHandoff(
  otkToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const otk = await parseOtk(otkToken); // throws HandoffError on a malformed otk1_
  const id = toHex(await handoffId(otk));
  const proof = toHex(await handoffClaimProof(otk));
  const res = await fetchFn("/api/handoff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, proof }),
  });
  if (res.status === 404) throw new Error("This pairing link was already used or has expired.");
  if (!res.ok) throw new Error("Pairing failed — please try again.");
  let box: unknown;
  try {
    ({ box } = (await res.json()) as { box?: unknown });
  } catch {
    throw new Error("Pairing failed — malformed response."); // non-JSON 200 body shouldn't leak a raw parse error
  }
  if (typeof box !== "string") throw new Error("Pairing failed — malformed response.");
  const plaintext = await openHandoff(otk, decodeHandoffBox(fromHex(box)));
  return new TextDecoder().decode(plaintext);
}
