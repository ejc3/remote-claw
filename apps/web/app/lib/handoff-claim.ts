import {
  decodeHandoffBox,
  fromHex,
  handoffClaimProof,
  handoffId,
  openHandoff,
  parseOtk,
  toHex,
} from "@remote-claw/clawsec";
import { handoffEnabled } from "./handoff-feature";

// Default-off one-time handoff consumer (docs/ephemeral-handoff.md). When enabled, POST id + proof to the
// same-origin endpoint, then open the returned box LOCALLY with the OTK. The OTK never leaves the browser;
// the server sees only hashes + ciphertext. Returns the resolved `rcp1_` pass.
export async function claimHandoff(
  otkToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!handoffEnabled()) {
    throw new Error("One-time pairing is not enabled on this deployment. Enter a pass manually.");
  }
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
