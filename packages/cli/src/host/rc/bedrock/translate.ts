// Anthropic `/v1/messages` → Amazon Bedrock translation (native `bedrock-mantle` path).
//
// The native endpoint (`bedrock-mantle.<region>.api.aws/anthropic/v1/messages`) speaks the EXACT
// api.anthropic.com wire format — standard SSE, top-level `model`, `anthropic-version` as a header —
// so the proxy only (1) rewrites the `model` to a Bedrock id, (2) scrubs body fields/headers Bedrock's
// strict validator rejects, and (3) swaps auth. The SSE response pipes back unchanged. These are the
// pure transforms (no I/O); the signing/transport live in `client.ts`, the wiring in `inference.ts`.

/** Map a claude model id to the Bedrock `bedrock-mantle` model id. claude sends ids like
 *  `claude-opus-4-8` or `claude-opus-4-8[1m]` (a context-window suffix); Bedrock wants the
 *  `anthropic.`-prefixed base. A caller-supplied override (`--rc-bedrock-model`) wins outright. */
export function mantleModelId(claudeModel: string, override?: string): string {
  if (override !== undefined && override.trim() !== "") return override.trim();
  // Strip a trailing `[...]` capability suffix (e.g. `[1m]`) — not part of the Bedrock id.
  const base = claudeModel.replace(/\[[^\]]*\]$/, "").trim();
  // Already a Bedrock id (anthropic.*, or a region-profile prefix like us./eu./global.) → pass through.
  if (/^(global\.|[a-z]{2}\.)?anthropic\./.test(base)) return base;
  return `anthropic.${base}`;
}

/** `anthropic-beta` features the native Bedrock path is known to accept. claude sends a long list
 *  (context-1m, effort-*, advisor-tool, context-management, prompt-caching-scope, …) that Bedrock's
 *  strict validator can 400 on; we keep only the allowlisted ones. Conservative by design — tune
 *  against a live Bedrock probe (see docs/bedrock-rc.md Appendix A). */
export const BEDROCK_ALLOWED_BETAS: ReadonlySet<string> = new Set([
  "interleaved-thinking-2025-05-14",
  "token-efficient-tools-2025-02-19",
]);

/** Body top-level keys Bedrock's native validator does not accept on a Messages request → strip them
 *  ("Extra inputs are not permitted" is a hard 400). `metadata` (user-id telemetry) is the one we have
 *  evidence for; the exact reject-set per model is live-tunable (see `extraStripKeys` / the doc), so a
 *  user who hits a 400 on e.g. `output_config`/`effort` can extend it via env without a code change. */
const STRIP_BODY_KEYS: ReadonlySet<string> = new Set(["metadata"]);

export interface TranslateOptions {
  /** Optional explicit Bedrock model id (overrides the mapped one). */
  modelOverride?: string;
  /** Allowlist of `anthropic-beta` tokens to keep (default `BEDROCK_ALLOWED_BETAS`). */
  allowedBetas?: ReadonlySet<string>;
  /** Additional top-level body keys to strip, on top of `STRIP_BODY_KEYS` (e.g. from
   *  `RC_BEDROCK_STRIP_KEYS` when a specific model rejects a field). */
  extraStripKeys?: ReadonlySet<string>;
}

/** Parse a comma-separated env value (e.g. RC_BEDROCK_STRIP_KEYS) into a key set, or undefined. */
export function parseStripKeys(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return undefined;
  const keys = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return keys.length > 0 ? new Set(keys) : undefined;
}

export interface TranslatedRequest {
  /** The rewritten request body bytes to sign+send (model mapped, stripped keys removed). */
  body: string;
  /** The Bedrock model id the body now carries. */
  model: string;
}

/** Reshape a claude `/v1/messages` JSON body for the native Bedrock endpoint: rewrite `model`, drop
 *  the keys Bedrock rejects. `stream`/`anthropic_version` stay as claude sent them (native path keeps
 *  top-level `stream`; `anthropic_version` is a header). Throws on non-JSON / non-object input. */
export function translateMessagesBody(raw: string, opts: TranslateOptions = {}): TranslatedRequest {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("messages body is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const claudeModel = typeof obj["model"] === "string" ? obj["model"] : "";
  const model = mantleModelId(claudeModel, opts.modelOverride);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_BODY_KEYS.has(k) || opts.extraStripKeys?.has(k)) continue;
    out[k] = v;
  }
  out["model"] = model;
  return { body: JSON.stringify(out), model };
}

/** Filter an `anthropic-beta` header value down to the Bedrock-accepted tokens. Empty result → "". */
export function filterBetaHeader(
  value: string | undefined,
  allowed: ReadonlySet<string> = BEDROCK_ALLOWED_BETAS,
): string {
  if (value === undefined) return "";
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((b) => b !== "" && allowed.has(b))
    .join(",");
}
