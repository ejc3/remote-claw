/** Broker URLs carry the machine auth bearer and, on protected deployments, a Vercel bypass.
 * Keep them to one canonical app origin so neither credential can be redirected or routed through a
 * caller-supplied path. Remote brokers require TLS; plain HTTP is only for local development. */

const HTTP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function withoutTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/** Explicit names and address literals that cannot be a remote deployment. DNS names outside the
 * reserved `.localhost` suffix are deliberately not resolved here: `RC_APP` remains the independent
 * exact trust pin, and network/DNS resolution would make this browser-safe parser stateful. */
function isLoopbackHostname(hostname: string): boolean {
  const host = withoutTrailingDot(hostname.toLowerCase());
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
  );
}

export class BrokerOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerOriginError";
  }
}

/** Parse and canonicalize the exact app origin accepted by every broker client. */
export function normalizeBrokerOrigin(raw: string): string {
  const hasAsciiSpaceOrControl = Array.from(raw).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
  if (raw === "" || raw.trim() !== raw || hasAsciiSpaceOrControl || !/^https?:\/\//i.test(raw)) {
    throw new BrokerOriginError("broker app must be an absolute http(s) origin");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrokerOriginError("broker app must be a valid absolute URL");
  }

  const authority = raw.slice(url.protocol.length + 2);
  const suffixAt = authority.search(/[/?#]/);
  const suffix = suffixAt === -1 ? "" : authority.slice(suffixAt);
  if (
    url.username !== "" ||
    url.password !== "" ||
    (suffix !== "" && suffix !== "/") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BrokerOriginError(
      "broker app must be a root origin with no credentials, path, query, or fragment",
    );
  }

  // A DNS trailing dot does not select a different host. Canonicalize it so origin pins cannot
  // disagree about two spellings of the same deployment, and `localhost.` stays loopback.
  if (url.hostname.endsWith(".")) url.hostname = withoutTrailingDot(url.hostname);

  if (url.protocol === "http:" && !HTTP_LOOPBACK_HOSTS.has(url.hostname)) {
    throw new BrokerOriginError(
      "remote broker apps require HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or [::1]",
    );
  }
  return url.origin;
}

export function isLoopbackBrokerOrigin(origin: string): boolean {
  return isLoopbackHostname(new URL(normalizeBrokerOrigin(origin)).hostname);
}

/**
 * Resolve the ambient Vercel bypass at the CLI boundary. `RC_APP` is the independent trust pin: a
 * command-line `--rc-app` may select a target, but it cannot redirect an ambient deployment secret.
 * Loopback never receives the bypass. Callers pass the returned value explicitly to lower layers.
 */
export function protectionBypassForBrokerOrigin(
  origin: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const normalized = normalizeBrokerOrigin(origin);
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (secret === undefined || secret === "" || isLoopbackBrokerOrigin(normalized)) return undefined;

  const pinnedRaw = env.RC_APP;
  if (pinnedRaw === undefined || pinnedRaw === "") {
    throw new BrokerOriginError(
      "VERCEL_AUTOMATION_BYPASS_SECRET is set; RC_APP must pin its exact trusted broker origin",
    );
  }
  const pinned = normalizeBrokerOrigin(pinnedRaw);
  if (pinned !== normalized) {
    throw new BrokerOriginError(
      "--rc-app does not match the RC_APP origin pinned for VERCEL_AUTOMATION_BYPASS_SECRET",
    );
  }
  return secret;
}
