// Resolve the auth the host uses to reach Bedrock. Two modes, in priority order:
//   1. Bearer  — AWS_BEARER_TOKEN_BEDROCK → Authorization: Bearer (no SigV4). Simplest.
//   2. SigV4   — static env creds, else the ECS/EKS container-credentials endpoint, else the EC2
//                instance role via IMDSv2.
// The host holds these; they are NEVER passed to the child claude (launch scrubs them). Not covered:
// AWS_PROFILE / SSO / web-identity assume-role — those need the AWS SDK's full provider chain; on
// such a box, hand the host an AWS_BEARER_TOKEN_BEDROCK (or static keys) instead.

import { readFile } from "node:fs/promises";
import type { AwsCredentials } from "./sigv4.js";

export type BedrockAuth =
  | { kind: "bearer"; token: string }
  | { kind: "sigv4"; credentials: AwsCredentials };

const IMDS = "http://169.254.169.254";
/** The ECS task-role metadata host that AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is relative to. */
const ECS_CREDS_HOST = "http://169.254.170.2";

/** The instance/container metadata credential JSON shape (IMDS + container endpoints agree on it). */
interface InstanceCredsJson {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  Token?: string;
  Expiration?: string;
}

/** Map a metadata credential JSON to AwsCredentials, or null if it lacks the required key pair. */
function credsFromJson(c: InstanceCredsJson): AwsCredentials | null {
  if (!c.AccessKeyId || !c.SecretAccessKey) return null;
  const expiration = c.Expiration ? Date.parse(c.Expiration) : Number.NaN;
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    ...(c.Token ? { sessionToken: c.Token } : {}),
    ...(Number.isFinite(expiration) ? { expiration } : {}),
  };
}

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
    return credsFromJson((await credRes.json()) as InstanceCredsJson);
  } catch {
    return null; // IMDS not present (not on EC2) / timed out
  }
}

/** Resolve credentials from the ECS/EKS container-credentials endpoint, or null if not configured.
 *  AWS injects AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (ECS, relative to 169.254.170.2) or
 *  AWS_CONTAINER_CREDENTIALS_FULL_URI (EKS Pod Identity, absolute) + an optional Authorization token
 *  (inline or via a file). The JSON shape matches IMDS, so credsFromJson handles both. */
export async function containerCredentials(timeoutMs = 3000): Promise<AwsCredentials | null> {
  const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
  const relative = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  const url = full || (relative ? `${ECS_CREDS_HOST}${relative}` : "");
  if (!url) return null;
  try {
    const headers: Record<string, string> = {};
    const tokenFile = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim();
    const token = tokenFile
      ? (await readFile(tokenFile, "utf8")).trim()
      : process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
    if (token) headers.authorization = token;
    const res = await fetchTimeout(url, { headers }, timeoutMs);
    if (!res.ok) return null;
    return credsFromJson((await res.json()) as InstanceCredsJson);
  } catch {
    return null; // endpoint unreachable / token file missing / timed out
  }
}

/** Resolve Bedrock auth: bearer token wins, else env creds, else the ECS/EKS container endpoint,
 *  else the EC2 IMDS instance role. */
export async function resolveBedrockAuth(): Promise<BedrockAuth> {
  const bearer = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (bearer) return { kind: "bearer", token: bearer };
  const env = envCredentials();
  if (env) return { kind: "sigv4", credentials: env };
  const container = await containerCredentials();
  if (container) return { kind: "sigv4", credentials: container };
  const imds = await imdsCredentials();
  if (imds) return { kind: "sigv4", credentials: imds };
  throw new Error(
    "no Bedrock credentials: set AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, " +
      "or run on ECS/EKS or an EC2 instance with a Bedrock role. " +
      "AWS_PROFILE/SSO/web-identity are not resolved — use a bearer token or static keys on such a box.",
  );
}

/** The AWS region for Bedrock calls: explicit override, else AWS_REGION / AWS_DEFAULT_REGION.
 *  Lowercased — the region feeds both the endpoint host and the SigV4 credential scope, which AWS
 *  requires lowercase (a stray `US-EAST-1` would yield an invalid host / signature mismatch). */
export function bedrockRegion(override?: string): string {
  return (
    override?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    "us-east-1"
  ).toLowerCase();
}
