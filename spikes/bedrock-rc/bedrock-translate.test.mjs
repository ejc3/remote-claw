import assert from "node:assert";
import {
  anthropicToBedrockBody, mapModelToInferenceProfile, filterBetas,
  EventStreamDecoder, bedrockChunkToSse, fakeBedrockChunk, encodeFrame,
} from "./bedrock-translate.mjs";

const CHUNK_HEADERS = { ":message-type": "event", ":event-type": "chunk", ":content-type": "application/json" };
const fakeBedrockChunkRaw = (obj) => encodeFrame(CHUNK_HEADERS, Buffer.from(JSON.stringify(obj)));

// A faithful fixture of the events a real `claude` /v1/messages SSE response carries (captured shapes:
// message_start w/ cache-aware usage → content_block_start → ping → text deltas → stop → message_delta
// → message_stop). Self-contained so the spike runs anywhere with no external capture.
const CAPTURED_EVENTS = [
  { type: "message_start", message: { id: "msg_01XJ9mBA9fJsmqiJxMJw75Ux", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7654, cache_creation_input_tokens: 14549, cache_read_input_tokens: 14072, output_tokens: 1, service_tier: "standard" } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "ping" },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "P" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "INEAPPLE" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 7654, output_tokens: 10 } },
  { type: "message_stop" },
];

let pass = 0;
const ok = (name) => { console.log("  ok -", name); pass++; };

// --- request reshape ---
{
  const body = { model: "claude-opus-4-8", stream: true, max_tokens: 1000, system: "s", messages: [{ role: "user", content: "hi" }] };
  const b = anthropicToBedrockBody(body);
  assert.strictEqual(b.model, undefined, "model dropped");
  assert.strictEqual(b.stream, undefined, "stream dropped");
  assert.strictEqual(b.anthropic_version, "bedrock-2023-05-31");
  assert.strictEqual(b.max_tokens, 1000);
  assert.deepStrictEqual(b.messages, body.messages);
  ok("reshape: drops model/stream, sets anthropic_version, keeps the rest");
}

// --- model map ---
{
  assert.strictEqual(mapModelToInferenceProfile("claude-opus-4-8", "us-west-1"), "us.anthropic.claude-opus-4-8-v1:0");
  assert.strictEqual(mapModelToInferenceProfile("claude-sonnet-4-6", "eu-central-1"), "eu.anthropic.claude-sonnet-4-6-v1:0");
  assert.strictEqual(mapModelToInferenceProfile("claude-opus-4-8", "ap-southeast-2"), "apac.anthropic.claude-opus-4-8-v1:0");
  ok("model→inference-profile with regional geo prefix");
}

// --- beta filter (real captured header) ---
{
  const real = "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07";
  const filtered = filterBetas(real);
  assert.strictEqual(filtered, "interleaved-thinking-2025-05-14", "only the Bedrock-accepted beta survives");
  assert.ok(!filtered.includes("context-1m"), "1M-context beta stripped");
  assert.ok(!filtered.includes("oauth"), "oauth beta stripped");
  ok("strips betas Bedrock rejects, keeps the allowlisted ones");
}

// --- event-stream round-trip against captured Anthropic event shapes ---
{
  const events = CAPTURED_EVENTS;

  // Build a single Bedrock binary stream from the events, plus one Bedrock-only metrics frame (no
  // `bytes` payload, like amazon-bedrock-invocationMetrics) that the translator must DROP.
  const metricsFrame = fakeBedrockChunkRaw({ "amazon-bedrock-invocationMetrics": { inputTokenCount: 7654, outputTokenCount: 10 } });
  const full = Buffer.concat([...events.map(fakeBedrockChunk), metricsFrame]);

  // Feed it to the decoder in deliberately awkward 7-byte slices to prove partial-frame handling.
  const dec = new EventStreamDecoder();
  const sseOut = [];
  for (let i = 0; i < full.length; i += 7) {
    for (const msg of dec.push(full.subarray(i, i + 7))) {
      const block = bedrockChunkToSse(msg);
      if (block) sseOut.push(block);
    }
  }
  const reconstructed = sseOut.join("");

  // Every original event type appears, in order, with intact data.
  const gotTypes = [...reconstructed.matchAll(/event: (\S+)/g)].map((m) => m[1]);
  const wantTypes = events.map((e) => e.type);
  assert.deepStrictEqual(gotTypes, wantTypes, "event types + order preserved through Bedrock framing");

  // Data payloads decode back to the identical event objects.
  const gotData = [...reconstructed.matchAll(/\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]));
  assert.deepStrictEqual(gotData, events, "event JSON byte-faithful after round-trip");
  ok(`event-stream round-trip on ${events.length} real captured events (7-byte chunked, partial frames)`);
}

console.log(`\nALL ${pass} translation checks passed.`);
