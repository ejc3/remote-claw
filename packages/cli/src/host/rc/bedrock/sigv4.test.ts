import { describe, expect, it } from "vitest";
import { amzTimestamp, signRequest } from "./sigv4.js";

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret/key" };
const base = {
  method: "POST",
  host: "bedrock-mantle.us-east-1.api.aws",
  path: "/anthropic/v1/messages",
  region: "us-east-1",
  service: "bedrock-mantle",
  body: '{"model":"anthropic.claude-opus-4-8","max_tokens":8}',
  headers: { "content-type": "application/json" },
  amzDate: "20260627T120000Z",
};

describe("amzTimestamp", () => {
  it("formats ISO8601 basic UTC", () => {
    expect(amzTimestamp(new Date("2026-06-27T12:00:00.000Z"))).toBe("20260627T120000Z");
  });
});

describe("signRequest", () => {
  it("produces a well-formed Authorization with the right scope + signed headers", () => {
    const h = signRequest({ ...base, credentials: CREDS });
    expect(h["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260627\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(h["x-amz-date"]).toBe("20260627T120000Z");
    expect(h["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["content-type"]).toBe("application/json"); // unsigned header still forwarded
  });

  it("is deterministic for fixed inputs and changes with the body", () => {
    const a = signRequest({ ...base, credentials: CREDS })["authorization"];
    const b = signRequest({ ...base, credentials: CREDS })["authorization"];
    expect(a).toBe(b);
    const c = signRequest({ ...base, body: `${base.body} `, credentials: CREDS })["authorization"];
    expect(c).not.toBe(a); // payload is hashed into the signature
  });

  it("adds x-amz-security-token (signed) for temporary credentials", () => {
    const h = signRequest({
      ...base,
      credentials: { ...CREDS, sessionToken: "tok" },
    });
    expect(h["x-amz-security-token"]).toBe("tok");
    expect(h["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });
});
