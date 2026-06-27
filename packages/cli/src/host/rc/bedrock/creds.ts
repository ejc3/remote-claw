// Resolve the auth the host uses to reach Bedrock. Two modes, in priority order:
//   1. Bearer  — AWS_BEARER_TOKEN_BEDROCK → Authorization: Bearer (no SigV4). Simplest.
//   2. SigV4   — static env creds, else the EC2/container instance-role chain via IMDSv2.
// The host holds these; they are NEVER passed to the child claude (launch scrubs them).

import type { AwsCredentials } from "./sigv4.js";

export type BedrockAuth =
  | { kind: "bearer"; token: string }
  | { kind: "sigv4"; credentials: AwsCredentials };

const IMDS = "http://169.254.169.254";

/** Fetch with a hard timeout (IMDS must never hang the proxy). */
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve static credentials from the standard AWS env vars, or null if unset. */
export function envCredentials(): AwsCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim();
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** Resolve credentials from the EC2/container instance role via IMDSv2, or null if unavailable. */
export async function imdsCredentials(timeoutMs = 3000): Promise<AwsCredentials | null> {
  try {
    const tokenRes = await fetchTimeout(
      `${IMDS}/latest/api/token`,
      { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": "60" } },
      timeoutMs,
    );
    if (!tokenRes.ok) return null;
    const token = await tokenRes.text();
    const h = { "x-aws-ec2-metadata-token": token };
    const roleRes = await fetchTimeout(
      `${IMDS}/latest/meta-data/iam/security-credentials/`,
      { headers: h },
      timeoutMs,
    );
    if (!roleRes.ok) return null;
    const role = (await roleRes.text()).trim().split("\n")[0];
    if (!role) return null;
    const credRes = await fetchTimeout(
      `${IMDS}/latest/meta-data/iam/security-credentials/${role}`,
      { headers: h },
      timeoutMs,
    );
    if (!credRes.ok) return null;
    const c = (await credRes.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
    };
    if (!c.AccessKeyId || !c.SecretAccessKey) return null;
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      ...(c.Token ? { sessionToken: c.Token } : {}),
    };
  } catch {
    return null; // IMDS not present (not on EC2) / timed out
  }
}

/** Resolve Bedrock auth: bearer token wins, else env creds, else the IMDS instance role. */
export async function resolveBedrockAuth(): Promise<BedrockAuth> {
  const bearer = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (bearer) return { kind: "bearer", token: bearer };
  const env = envCredentials();
  if (env) return { kind: "sigv4", credentials: env };
  const imds = await imdsCredentials();
  if (imds) return { kind: "sigv4", credentials: imds };
  throw new Error(
    "no Bedrock credentials: set AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or run on an instance with a Bedrock role",
  );
}

/** The AWS region for Bedrock calls: explicit override, else AWS_REGION / AWS_DEFAULT_REGION. */
export function bedrockRegion(override?: string): string {
  return (
    override?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    "us-east-1"
  );
}
