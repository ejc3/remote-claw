import { timingSafeEqual, utf8 } from "@remote-claw/clawsec";

/** Only loopback origins may seed locally: the host side loops authenticated requests back to THIS
 *  server, so a spoofed Host header must not be able to point them at another origin (SSRF). */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** Constant-time check of the `x-dev-seed-token` header against the DEV_SEED_TOKEN secret. */
function tokenMatches(got: string | null): boolean {
  const want = process.env.DEV_SEED_TOKEN;
  if (!want || got === null) return false;
  const a = utf8(got);
  const b = utf8(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether THIS request may seed (and the trusted self-origin to loop the host relay back to), or a
 *  Response to return (404/400). Local dev requires loopback; a Vercel preview requires the token. */
export function gate(req: Request): { origin: string } | Response {
  const onVercel = process.env.VERCEL === "1";
  const isProd = process.env.VERCEL_ENV === "production";
  const localDev = process.env.BROKER_BACKEND === "local" && !onVercel;
  const previewSeed = !isProd && tokenMatches(req.headers.get("x-dev-seed-token"));
  if (!localDev && !previewSeed) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }
  // On Vercel, loop back to the deployment's OWN canonical URL (a trusted env var, not the Host
  // header) -- no SSRF surface. Locally, take the request origin but require loopback.
  if (process.env.VERCEL_URL) return { origin: `https://${process.env.VERCEL_URL}` };
  const url = new URL(req.url);
  if (!isLoopback(url.hostname)) {
    return new Response(JSON.stringify({ error: "seed is loopback-only" }), { status: 400 });
  }
  return { origin: url.origin };
}
