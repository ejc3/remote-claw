// Default-off producer for `--rc-pass --rc-qr --rc-app <origin>`. Once the deployment's external WAF
// control is verified and NEXT_PUBLIC_RC_HANDOFF_ENABLED=1, mint an OTK, seal the forever pass under it,
// upload the box, and return `<origin>/#otk1_<OTK>`. The broker sees only one-way hashes + ciphertext; the
// OTK rides the URL #fragment and never reaches a server.
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
import {
  BrokerOriginError,
  isLoopbackBrokerOrigin,
  normalizeBrokerOrigin,
} from "./broker/origin.js";

export interface UploadHandoffOptions {
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable deployment env (tests). Production reads process.env. */
  env?: NodeJS.ProcessEnv;
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
  const env = opts.env ?? process.env;
  if (env.NEXT_PUBLIC_RC_HANDOFF_ENABLED !== "1") {
    throw new Error(
      "one-time handoff is disabled; set NEXT_PUBLIC_RC_HANDOFF_ENABLED=1 only after verifying the deployment's per-IP WAF rate limit",
    );
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  if (fetchFn === undefined) throw new Error("uploadHandoff: global fetch is unavailable");
  let appOrigin: string;
  try {
    appOrigin = normalizeBrokerOrigin(origin);
  } catch (e) {
    if (e instanceof BrokerOriginError) throw new Error(`uploadHandoff: ${e.message}`);
    throw e;
  }
  if (
    opts.bypass !== undefined &&
    (new URL(appOrigin).protocol !== "https:" || isLoopbackBrokerOrigin(appOrigin))
  ) {
    throw new Error(
      "uploadHandoff: the Vercel protection bypass requires a remote HTTPS app origin",
    );
  }
  const apiUrl = `${appOrigin}/api/handoff`;
  const deepLinkBase = `${appOrigin}/`;
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
    const res = await fetchFn(apiUrl, {
      method: "PUT",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 409) continue; // id already taken → re-mint a fresh OTK
    if (!res.ok) throw new Error(`handoff upload failed: HTTP ${res.status}`);
    return `${deepLinkBase}#${await formatOtk(otk)}`;
  }
  throw new Error("handoff upload failed: repeated id conflicts");
}
