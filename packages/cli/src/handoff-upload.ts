// `--rc-pass --rc-qr --rc-app <origin>`: instead of putting the FOREVER pass in the QR, mint a one-time
// key (OTK), seal the pass under it, upload the sealed box to the broker's zero-knowledge handoff store, and
// return the QR/deep-link `<origin>/#otk1_<OTK>`. The QR is then a single-use, TTL-bounded bootstrap token,
// not a permanent credential (docs/ephemeral-handoff.md). The broker only ever sees one-way hashes + a blob
// it cannot read; the OTK rides the URL #fragment and never reaches a server.
import {
  encodeHandoffBox,
  formatOtk,
  generateOtk,
  handoffClaimProof,
  handoffId,
  handoffProofHash,
  sealHandoff,
  toHex,
  utf8,
} from "@remote-claw/clawsec";

export interface UploadHandoffOptions {
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Vercel Deployment-Protection bypass for an SSO-gated preview origin (prod /api is public). */
  bypass?: string;
  /** Requested TTL seconds (the server clamps to its own [MIN, MAX]); omit ⇒ server default (10 min). */
  ttlS?: number;
}

const MAX_REMINT = 3;

/** Upload the sealed pass and return the `<origin>/#otk1_<OTK>` deep link. Re-mints on a 409 id clash
 *  (astronomically rare) so a poisoned/pre-seeded row never makes us publish a QR we don't own. */
export async function uploadHandoff(
  origin: string,
  pass: string,
  opts: UploadHandoffOptions = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (fetchFn === undefined) throw new Error("uploadHandoff: global fetch is unavailable");
  // Validate + normalize the origin: a real http(s) origin only; strip any query/fragment so a malformed
  // `--rc-app` can't produce a wrong PUT URL or a broken deep link.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`uploadHandoff: invalid app origin "${origin}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`uploadHandoff: app origin must be http(s), got "${origin}"`);
  }
  parsed.hash = "";
  parsed.search = "";
  const path = parsed.pathname.replace(/\/+$/, ""); // drop trailing slash(es); root → ""
  const apiUrl = `${parsed.origin}/api/handoff`; // the broker route is at the origin ROOT
  const deepLinkBase = `${parsed.origin}${path === "" ? "/" : path}`; // viewer page for the #otk1_ deep link
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bypass) headers["x-vercel-protection-bypass"] = opts.bypass;

  for (let attempt = 0; attempt < MAX_REMINT; attempt++) {
    const otk = generateOtk();
    const claimProof = await handoffClaimProof(otk);
    const body: Record<string, unknown> = {
      id: toHex(await handoffId(otk)),
      proof_hash: toHex(await handoffProofHash(claimProof)),
      ct: toHex(encodeHandoffBox(await sealHandoff(otk, utf8(pass)))),
    };
    if (opts.ttlS !== undefined) body.ttl = opts.ttlS;
    const res = await fetchFn(apiUrl, { method: "PUT", headers, body: JSON.stringify(body) });
    if (res.status === 409) continue; // id already taken → re-mint a fresh OTK
    if (!res.ok) throw new Error(`handoff upload failed: HTTP ${res.status}`);
    return `${deepLinkBase}#${await formatOtk(otk)}`;
  }
  throw new Error("handoff upload failed: repeated id conflicts");
}
