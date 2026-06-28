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
  // mantle uses the NEW, UNDATED model ids. The main model is already undated (`claude-opus-4-8`),
  // but claude's quick/"haiku" helper sends a DATED id (`claude-haiku-4-5-20251001`) which mantle
  // 404s — so strip a trailing `-YYYYMMDD` date before prefixing. Verified live against mantle:
  // `anthropic.claude-haiku-4-5-20251001` → 404, `anthropic.claude-haiku-4-5` → 200.
  const undated = base.replace(/-\d{8}$/, "");
  return `anthropic.${undated}`;
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
 *  ("Extra inputs are not permitted" is a hard 400). Live-confirmed against `claude` 2.1.x → mantle
 *  (claude-opus-4-8, us-east-1, 2026-06-27): the real client sends `metadata` (user-id telemetry),
 *  `context_management`, and `diagnostics`, all of which mantle rejects; `output_config`/`thinking`/
 *  `tools` it ACCEPTS, so those stay. The reject-set can still drift per model, so it's env-extensible
 *  (see `extraStripKeys` / `RC_BEDROCK_STRIP_KEYS`) without a code change. */
const STRIP_BODY_KEYS: ReadonlySet<string> = new Set([
  "metadata",
  "context_management",
  "diagnostics",
]);

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

/** Deep-strip nested fields the mantle validator rejects but that claude embeds throughout the body
 *  (so a flat top-level `STRIP_BODY_KEYS` can't reach them). Known case: a `cache_control` block
 *  carrying the prompt-caching `scope` sub-field — a beta we drop from the `anthropic-beta` header but
 *  which ALSO rides inside every cached `system`/content/tool block, so mantle 400s with
 *  "system.N.cache_control.ephemeral.scope: Extra inputs are not permitted". We delete only `scope`,
 *  keeping `cache_control: {type:"ephemeral"}` itself (mantle accepts that), so prompt caching survives.
 *  Mutates in place — `obj` is a throwaway parse owned by translateMessagesBody. */
function stripMantleRejectedNested(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripMantleRejectedNested(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const cc = obj.cache_control;
  // Only Anthropic's prompt-cache breakpoint — `{type:"ephemeral", …}` — carries the rejected `scope`.
  // Gate on `type==="ephemeral"` so we never touch an arbitrary `cache_control` a tool/user payload
  // happens to carry (which could legitimately have its own `scope`), corrupting their data.
  if (
    cc !== null &&
    typeof cc === "object" &&
    !Array.isArray(cc) &&
    (cc as Record<string, unknown>).type === "ephemeral"
  ) {
    delete (cc as Record<string, unknown>).scope;
  }
  for (const v of Object.values(obj)) stripMantleRejectedNested(v);
}

/** Reshape a claude `/v1/messages` JSON body for the native Bedrock endpoint: rewrite `model`, drop
 *  the keys Bedrock rejects (top-level + the nested `cache_control.scope`). `stream`/`anthropic_version`
 *  stay as claude sent them (native path keeps top-level `stream`; `anthropic_version` is a header).
 *  Throws on non-JSON / non-object input. */
export function translateMessagesBody(raw: string, opts: TranslateOptions = {}): TranslatedRequest {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("messages body is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const claudeModel = typeof obj.model === "string" ? obj.model : "";
  const model = mantleModelId(claudeModel, opts.modelOverride);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_BODY_KEYS.has(k) || opts.extraStripKeys?.has(k)) continue;
    out[k] = v;
  }
  out.model = model;
  stripMantleRejectedNested(out);
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
