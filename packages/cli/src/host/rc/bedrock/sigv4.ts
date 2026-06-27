// Minimal AWS Signature V4 for Bedrock requests — node:crypto only, no AWS SDK dependency.
// Signs the EXACT body bytes (SigV4 hashes the payload), per
// docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html. Validated
// against the live `bedrock-mantle` endpoint (a good signature → permission_error, a bad one →
// InvalidSignatureException). The signing service differs by endpoint: `bedrock-mantle` for the
// native Messages endpoint, `bedrock` for `bedrock-runtime`.

import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (STS / instance role); adds x-amz-security-token. */
  sessionToken?: string;
  /** Epoch ms when temporary credentials expire (from IMDS); used by callers to refresh in time. */
  expiration?: number;
}

export interface SignParams {
  method: string;
  host: string;
  /** Request path (no query). */
  path: string;
  region: string;
  service: string;
  /** Exact body bytes that will be transmitted. */
  body: string;
  /** Extra request headers to SEND (e.g. content-type, anthropic-version). Only host/x-amz-* and
   *  content-type are signed; the rest ride along unsigned (AWS ignores unsigned headers). */
  headers?: Record<string, string>;
  credentials: AwsCredentials;
  /** Override the request timestamp (tests); defaults to now. Format YYYYMMDDTHHMMSSZ. */
  amzDate?: string;
}

const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** ISO8601 basic UTC timestamp `YYYYMMDDTHHMMSSZ` from a Date. */
export function amzTimestamp(date: Date): string {
  return `${date.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
}

/** Sign a request and return the full header set to send (Authorization + x-amz-*). */
export function signRequest(params: SignParams): Record<string, string> {
  const { method, host, path, region, service, body, credentials } = params;
  const amzDate = params.amzDate ?? amzTimestamp(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  // Signed headers: host, content-type, the x-amz-* set. Keep names lowercase + sorted.
  const signed: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const contentType = params.headers?.["content-type"] ?? params.headers?.["Content-Type"];
  if (contentType !== undefined) signed["content-type"] = contentType;
  if (credentials.sessionToken !== undefined) {
    signed["x-amz-security-token"] = credentials.sessionToken;
  }

  const sortedNames = Object.keys(signed).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${signed[n]?.trim()}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    "", // canonical query string (none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Return everything to SEND: the extra (unsigned) headers, then the signed x-amz-* + Authorization.
  const out: Record<string, string> = { ...(params.headers ?? {}) };
  out["x-amz-date"] = amzDate;
  out["x-amz-content-sha256"] = payloadHash;
  if (credentials.sessionToken !== undefined)
    out["x-amz-security-token"] = credentials.sessionToken;
  out.authorization = authorization;
  return out;
}
