// Bedrock <-> Anthropic translation core (zero-dep spike).
//   1. anthropicToBedrockBody(): reshape claude's /v1/messages body for InvokeModelWithResponseStream.
//   2. AWS vnd.amazon.eventstream encode/decode (incremental) — encode is only for the self-test;
//      decode is what a real proxy needs to turn Bedrock's binary stream into Anthropic SSE.
//   3. bedrockChunkToSse(): an Anthropic event object -> exact SSE block claude expects.
// Proves the wire translation end-to-end without AWS creds, against a synthetic Bedrock stream.
import { crc32 as zlibCrc32 } from "node:zlib";

// ---------- 1. request reshape ----------

// anthropic-beta features Bedrock's Anthropic runtime is known to accept. Everything else claude sends
// (context-1m, effort-*, advisor-tool, context-management, prompt-caching-scope, mid-conversation-*,
// cache-diagnosis, …) is stripped to avoid a 400. NOTE: refine against a live Bedrock probe (Appendix A).
const BEDROCK_OK_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "token-efficient-tools-2025-02-19",
]);

// Anthropic public id -> Bedrock cross-region inference-profile id. Region prefix (us./eu./apac.)
// is applied from the configured AWS region. Several Claude models are invocable ONLY via a profile.
const MODEL_BASE = {
  "claude-opus-4-8": "anthropic.claude-opus-4-8-v1:0",
  "claude-sonnet-4-6": "anthropic.claude-sonnet-4-6-v1:0",
  "claude-3-5-haiku-20241022": "anthropic.claude-3-5-haiku-20241022-v1:0",
};
export function mapModelToInferenceProfile(model, region = "us-west-1") {
  const base = MODEL_BASE[model] ?? `anthropic.${model}-v1:0`;
  const geo = region.startsWith("eu") ? "eu" : region.startsWith("ap") ? "apac" : "us";
  return `${geo}.${base}`;
}

export function anthropicToBedrockBody(body) {
  const { model, stream, ...rest } = body; // drop model (→URL) and stream (→endpoint)
  return { anthropic_version: "bedrock-2023-05-31", ...rest };
}

export function filterBetas(betaHeader) {
  return (betaHeader ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((b) => b && BEDROCK_OK_BETAS.has(b))
    .join(",");
}

// ---------- 2. AWS event-stream framing ----------

function crc32(buf) {
  // node:zlib.crc32 (Node ≥20) returns an unsigned int; fall back is unnecessary in our runtime.
  return zlibCrc32(buf) >>> 0;
}

// Encode ONE message (headers: name->string value) — used by the self-test to fabricate a stream.
export function encodeFrame(headers, payload) {
  const hParts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, "utf8");
    const v = Buffer.from(value, "utf8");
    const head = Buffer.alloc(1 + n.length + 1 + 2);
    head.writeUInt8(n.length, 0);
    n.copy(head, 1);
    head.writeUInt8(7, 1 + n.length); // 7 = string
    head.writeUInt16BE(v.length, 1 + n.length + 1);
    hParts.push(head, v);
  }
  const headerBuf = Buffer.concat(hParts);
  const total = 4 + 4 + 4 + headerBuf.length + payload.length + 4;
  const msg = Buffer.alloc(total);
  msg.writeUInt32BE(total, 0);
  msg.writeUInt32BE(headerBuf.length, 4);
  msg.writeUInt32BE(crc32(msg.subarray(0, 8)), 8);
  headerBuf.copy(msg, 12);
  payload.copy(msg, 12 + headerBuf.length);
  msg.writeUInt32BE(crc32(msg.subarray(0, total - 4)), total - 4);
  return msg;
}

// Incremental decoder: feed arbitrary chunks, yields {headers, payload} per complete message.
export class EventStreamDecoder {
  #buf = Buffer.alloc(0);
  push(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const out = [];
    while (this.#buf.length >= 12) {
      const total = this.#buf.readUInt32BE(0);
      if (this.#buf.length < total) break; // wait for the rest of the message
      const headersLen = this.#buf.readUInt32BE(4);
      const preludeCrc = this.#buf.readUInt32BE(8);
      if (crc32(this.#buf.subarray(0, 8)) !== preludeCrc) throw new Error("prelude CRC mismatch");
      const headers = {};
      let p = 12;
      const headersEnd = 12 + headersLen;
      while (p < headersEnd) {
        const nameLen = this.#buf.readUInt8(p); p += 1;
        const name = this.#buf.toString("utf8", p, p + nameLen); p += nameLen;
        const type = this.#buf.readUInt8(p); p += 1;
        if (type === 7) {
          const vlen = this.#buf.readUInt16BE(p); p += 2;
          headers[name] = this.#buf.toString("utf8", p, p + vlen); p += vlen;
        } else { throw new Error(`unsupported header type ${type}`); }
      }
      const payload = this.#buf.subarray(headersEnd, total - 4);
      out.push({ headers, payload: Buffer.from(payload) });
      this.#buf = this.#buf.subarray(total);
    }
    return out;
  }
}

// ---------- 3. Bedrock chunk -> Anthropic SSE ----------

// A Bedrock "chunk" message payload is {"bytes":"<base64 of one Anthropic event JSON>"}.
// Return the EXACT SSE block claude expects (event: <type>\ndata: <json>\n\n), or null to drop.
export function bedrockChunkToSse(message) {
  const mtype = message.headers[":message-type"];
  const etype = message.headers[":event-type"];
  if (mtype === "exception" || mtype === "error") {
    const j = JSON.parse(message.payload.toString("utf8"));
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: j.message ?? etype } })}\n\n`;
  }
  const outer = JSON.parse(message.payload.toString("utf8"));
  if (outer.bytes === undefined) return null; // e.g. amazon-bedrock-invocationMetrics — drop
  const eventJson = Buffer.from(outer.bytes, "base64").toString("utf8");
  const ev = JSON.parse(eventJson);
  return `event: ${ev.type}\ndata: ${eventJson}\n\n`;
}

// Wrap an Anthropic event the way Bedrock does (self-test helper).
export function fakeBedrockChunk(ev) {
  const inner = Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(ev)).toString("base64") }));
  return encodeFrame({ ":message-type": "event", ":event-type": "chunk", ":content-type": "application/json" }, inner);
}
