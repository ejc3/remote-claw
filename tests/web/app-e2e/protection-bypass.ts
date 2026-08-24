import type { BrowserContext } from "@playwright/test";

const TRUSTED_VERCEL_HOST_PREFIX = "remote-claw-";
const TRUSTED_VERCEL_HOST_SUFFIX = "-ejc3-7031s-projects.vercel.app";

function targetOrigin(baseURL: string): URL {
  const target = new URL(baseURL);
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.port !== "" ||
    !target.hostname.startsWith(TRUSTED_VERCEL_HOST_PREFIX) ||
    !target.hostname.endsWith(TRUSTED_VERCEL_HOST_SUFFIX)
  ) {
    throw new Error(
      "credential-bearing proof target is not the pinned HTTPS Vercel project/team origin",
    );
  }
  return new URL(target.origin);
}

/** Keep a globally configured bypass out of local/non-Vercel test traffic. */
export function bypassForTarget(baseURL: string, secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  const target = new URL(baseURL);
  if (
    (target.hostname === "localhost" || target.hostname === "127.0.0.1") &&
    target.username === "" &&
    target.password === ""
  )
    return undefined;
  targetOrigin(baseURL);
  return secret;
}

/**
 * Prime Vercel's origin-scoped HttpOnly bypass cookie with exactly one credential-bearing request.
 * The browser context receives no global extraHTTPHeaders, so a page-controlled cross-origin request
 * can never inherit the project-wide bypass secret. Redirect following is manual and only a same-origin
 * redirect is accepted. Playwright tracing is disabled in every config that calls this helper.
 */
export async function primeVercelBypass(
  context: BrowserContext,
  baseURL: string,
  secret: string | undefined,
): Promise<void> {
  const scopedSecret = bypassForTarget(baseURL, secret);
  if (scopedSecret === undefined) return;
  const origin = targetOrigin(baseURL);
  const response = await context.request.get(origin.href, {
    headers: {
      "x-vercel-protection-bypass": scopedSecret,
      "x-vercel-set-bypass-cookie": "true",
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const status = response.status();
  if (status >= 200 && status < 300) return;
  if (status < 300 || status >= 400) {
    throw new Error(`Vercel bypass bootstrap failed with HTTP ${status}`);
  }
  const location = response.headers().location;
  if (!location || new URL(location, origin).origin !== origin.origin) {
    throw new Error("Vercel bypass bootstrap attempted a cross-origin redirect");
  }
  const cookies = await context.cookies(origin.href);
  if (cookies.length === 0) throw new Error("Vercel bypass bootstrap set no origin cookie");
}
