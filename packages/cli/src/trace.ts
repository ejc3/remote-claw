// A tiny structured tracer — Rust `tracing` in spirit, sized for one CLI. It is:
//   • leveled       error < warn < info < debug < trace
//   • target-scoped each call site names a target ("rc.relay", "rc.mitm", "rc.session", …)
//   • env-filtered  RC_LOG selects what's emitted, RUST_LOG-style ("debug", "rc.mitm=debug,warn")
//   • span-like     child() binds fields (e.g. { session }) onto every line beneath it
//   • local-only    the default sink is stderr; it never reaches the broker, --rc-json, or stdout
//     (the secret-leak surfaces, see secretleak.ts). This runs on the SAME machine that already holds
//     the raw transcript, so logging conversation content/titles is not a leak — be pragmatic, not
//     paranoid. The one hard rule: NEVER pass key material (the AEAD/session keys, the rc master
//     secret) to a trace call. Content rides at debug+, and `trace` is the unclipped firehose AFTER
//     recursive credential redaction; malformed JSON protocol bodies fail closed.
//
// Off by default for everything below `warn`, so a normal run is quiet (signal/noise, not secrecy);
// opt into diagnosis with `RC_LOG=debug` (all) or `RC_LOG=rc.relay=trace,rc.mitm=debug` (per target).

import { closeSync, constants, fchmodSync, fstatSync, openSync, writeFileSync } from "node:fs";

export type Level = "error" | "warn" | "info" | "debug" | "trace";

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const OFF = -1;

/** A structured field value. Deliberately scalar-only: you cannot log an object/body wholesale. */
export type Field = string | number | boolean | null | undefined;
export type Fields = Record<string, Field>;

/** Stable marker used in every trace sink when credential material is removed. */
export const TRACE_REDACTED = "<REDACTED>";

const TRACE_REDACTION_FAILED = "<REDACTION_FAILED>";
const MAX_JSON_REDACTION_DEPTH = 64;

const SENSITIVE_TRACE_KEYS = new Set([
  "access_token",
  "anthropic_api_key",
  "anthropic_auth_token",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authentication",
  "authorization",
  "aws_secret_access_key",
  "bearer_token",
  "client_secret",
  "cookie",
  "credential",
  "credentials",
  "id_token",
  "jwt",
  "oauth_token",
  "password",
  "passwd",
  "private_key",
  "proxy_authorization",
  "refresh_token",
  "resume_token",
  "secret",
  "secret_access_key",
  "session_token",
  "set_cookie",
  "setup_token",
  "token",
  "worker_jwt",
  "x_amz_security_token",
  "x_api_key",
  "x_vercel_protection_bypass",
]);
const SENSITIVE_TRACE_KEY_SEGMENTS = new Set([
  "auth",
  "authentication",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "jwt",
  "key",
  "password",
  "passwd",
  "secret",
  "token",
]);

function normalizedTraceKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** True when a structured field name conventionally carries a credential. */
export function isSensitiveTraceKey(key: string): boolean {
  const normalized = normalizedTraceKey(key);
  if (SENSITIVE_TRACE_KEYS.has(normalized)) return true;
  if (normalized.split("_").some((segment) => SENSITIVE_TRACE_KEY_SEGMENTS.has(segment)))
    return true;
  return [
    "api_key",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "jwt",
    "password",
    "passwd",
    "private_key",
    "secret",
    "token",
  ].some((suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`));
}

const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/=_~.-]+/gi;
const COMPACT_JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ANTHROPIC_TOKEN_RE = /\bsk-ant-[A-Za-z0-9._-]{8,}\b/g;
const REMOTE_CLAW_TOKEN_RE = /\b(?:rc1|rcp1|otk1)_[A-Za-z0-9_-]{8,}\b/g;
const AUTHORIZATION_HEADER_RE =
  /(\b(?:proxy[-_]?authorization|authorization)\b\s*[:=]\s*)[^\r\n]*/gi;
const COOKIE_HEADER_RE = /(\b(?:set[-_]?cookie|cookie)\b\s*[:=]\s*)[^\r\n]*/gi;
const KEY_PREFIX_RE = /["']?\b([a-z][a-z0-9_.-]*)\b["']?\s*[:=]\s*/gi;

function credentialValueEnd(text: string, start: number): number {
  const first = text[start];
  // A credential-bearing compound value can span arbitrarily many lines. The lexical fallback does not
  // attempt to parse nested/malformed JSON; omit the rest of this diagnostic instead of leaking a tail.
  if (first === "{" || first === "[") return text.length;
  if (first === `"` || first === `'`) {
    let escaped = false;
    for (let i = start + 1; i < text.length; i += 1) {
      const char = text[i];
      if (char === "\n" || char === "\r") return text.length; // malformed quote: fail closed
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === first) {
        return i + 1;
      }
    }
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[\s,;&}\]]/.test(text[end] ?? "")) end += 1;
  return end;
}

/** Redact ordinary key:value/key=value diagnostics without letting a safe outer key shield a nested
 * JSON credential. Non-sensitive matches advance only to their value, where scanning continues. */
function redactSensitivePairs(text: string): string {
  let copiedThrough = 0;
  let searchFrom = 0;
  let output = "";
  while (searchFrom < text.length) {
    KEY_PREFIX_RE.lastIndex = searchFrom;
    const match = KEY_PREFIX_RE.exec(text);
    if (match === null) break;
    const key = match[1] ?? "";
    const valueStart = match.index + match[0].length;
    if (!isSensitiveTraceKey(key)) {
      searchFrom = Math.max(valueStart, match.index + 1);
      continue;
    }
    const valueEnd = credentialValueEnd(text, valueStart);
    output += text.slice(copiedThrough, match.index);
    output += `${match[0]}${TRACE_REDACTED}`;
    copiedThrough = valueEnd;
    searchFrom = Math.max(valueEnd, valueStart + 1);
  }
  return `${output}${text.slice(copiedThrough)}`;
}

function redactLexicalSecrets(text: string): string {
  const tokenSafe = text
    .replace(AUTHORIZATION_HEADER_RE, (_match, prefix: string) => `${prefix}${TRACE_REDACTED}`)
    .replace(COOKIE_HEADER_RE, (_match, prefix: string) => `${prefix}${TRACE_REDACTED}`)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} ${TRACE_REDACTED}`)
    .replace(COMPACT_JWT_RE, TRACE_REDACTED)
    .replace(ANTHROPIC_TOKEN_RE, TRACE_REDACTED)
    .replace(REMOTE_CLAW_TOKEN_RE, TRACE_REDACTED);
  return redactSensitivePairs(tokenSafe);
}

function redactJsonValue(value: unknown, depth: number): unknown {
  if (depth > MAX_JSON_REDACTION_DEPTH) return TRACE_REDACTED;
  if (typeof value === "string") return redactLexicalSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const safeKey = redactLexicalSecrets(key);
        return [
          safeKey,
          isSensitiveTraceKey(key) ? TRACE_REDACTED : redactJsonValue(item, depth + 1),
        ];
      }),
    );
  }
  return value;
}

/**
 * Redact a JSON protocol body. Invalid/truncated input fails closed: trace mode records only a byte
 * count, never the original text that could contain an unrecognised credential shape.
 */
export function redactJsonTraceBody(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(redactJsonValue(parsed, 0));
  } catch {
    return `${TRACE_REDACTION_FAILED} bytes=${Buffer.byteLength(text, "utf8")}`;
  }
}

/**
 * Redact credentials embedded in an ordinary diagnostic string. JSON-looking strings are walked
 * structurally; malformed JSON-looking input fails closed instead of falling back to raw output.
 */
export function redactTraceText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return redactJsonTraceBody(text);
  return redactLexicalSecrets(text);
}

function redactTraceFields(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const safeKey = redactLexicalSecrets(key);
      return [
        safeKey,
        isSensitiveTraceKey(key)
          ? TRACE_REDACTED
          : typeof value === "string"
            ? redactTraceText(value)
            : value,
      ];
    }),
  );
}

/** One emitted record, handed to a sink. The default sink formats it; tests can capture it raw. */
export interface TraceRecord {
  level: Level;
  target: string;
  msg: string;
  fields: Fields;
  time: number;
}

function redactTraceRecord(rec: TraceRecord): TraceRecord {
  return {
    ...rec,
    msg: redactTraceText(rec.msg),
    fields: redactTraceFields(rec.fields),
  };
}

export type Sink = (rec: TraceRecord) => void;

export interface Tracer {
  error(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  debug(msg: string, fields?: Fields): void;
  trace(msg: string, fields?: Fields): void;
  /** A child tracer with `fields` bound onto every record (span-like context). */
  child(fields: Fields): Tracer;
  /** True if `level` would be emitted for this target — guard expensive field construction with it. */
  enabled(level: Level): boolean;
}

/** Resolve an enabled rank for a target. -1 (OFF) means nothing is emitted. */
export type Filter = (target: string) => number;

function asLevel(s: string): Level | "off" | null {
  const t = s.toLowerCase();
  if (t === "off") return "off";
  return t in RANK ? (t as Level) : null;
}

/**
 * Parse an RC_LOG spec into a target→rank filter. Comma-separated directives; a bare level
 * ("debug") sets the global default, `target=level` ("rc.mitm=debug") scopes a target prefix.
 * The longest matching target prefix wins (dot-segmented, so "rc" matches "rc.relay"). When the
 * spec is undefined the default is `warn`; when a spec is given but sets no global default,
 * unmatched targets are OFF (naming a target silences the rest, like RUST_LOG).
 */
export function buildFilter(spec: string | undefined): Filter {
  const rules: { target: string; rank: number }[] = [];
  let global: number | null = null;
  for (const part of (spec ?? "").split(",")) {
    const d = part.trim();
    if (d === "") continue;
    const eq = d.indexOf("=");
    if (eq === -1) {
      const lvl = asLevel(d);
      if (lvl !== null) global = lvl === "off" ? OFF : RANK[lvl];
    } else {
      const target = d.slice(0, eq).trim();
      const lvl = asLevel(d.slice(eq + 1).trim());
      if (target !== "" && lvl !== null)
        rules.push({ target, rank: lvl === "off" ? OFF : RANK[lvl] });
    }
  }
  // Default for unmatched targets: a global directive wins; else, if there ARE valid target rules,
  // others are OFF (naming a target silences the rest, like RUST_LOG); else (empty/typo'd spec with
  // no usable directive) fall back to warn — a garbled RC_LOG must never silence errors.
  const def = global ?? (rules.length > 0 ? OFF : RANK.warn);
  return (target: string) => {
    let best = def;
    let bestLen = -1;
    for (const r of rules) {
      if ((target === r.target || target.startsWith(`${r.target}.`)) && r.target.length > bestLen) {
        best = r.rank;
        bestLen = r.target.length;
      }
    }
    return best;
  };
}

function clip(s: string): string {
  // Keep lines bounded; a stray large value is truncated rather than dumped (defense in depth — call
  // sites should pass ids/lengths, never bodies).
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

function fmtField(v: Field, clipLong: boolean): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    const s = clipLong ? clip(v) : v;
    return /[\s="]/.test(s) ? JSON.stringify(s) : s;
  }
  return String(v);
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function three(n: number): string {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n);
}

/** Default human formatter: `HH:MM:SS.mmm LEVEL target msg key=val …` (fields clipped for the eye). */
export function formatRecord(rec: TraceRecord): string {
  const safe = redactTraceRecord(rec);
  const d = new Date(safe.time);
  const ts = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${three(d.getMilliseconds())}`;
  const lvl = safe.level.toUpperCase().padEnd(5);
  // `trace` is the deliberate firehose — show full redacted bodies; info/debug clip long fields.
  const clipLong = safe.level !== "trace";
  let line = `${ts} ${lvl} ${safe.target} ${safe.msg}`;
  for (const [k, v] of Object.entries(safe.fields)) line += ` ${k}=${fmtField(v, clipLong)}`;
  return line;
}

/** Machine formatter: one JSON object per line, fields UNclipped — for an on-disk capture you can
 *  grep/replay later (RC_LOG_FORMAT=json + RC_LOG_FILE). Known credential keys and token shapes are
 *  redacted; call sites must still never pass cryptographic key material. */
export function formatRecordJson(rec: TraceRecord): string {
  const safe = redactTraceRecord(rec);
  // Canonical keys are spread LAST so a field that happens to be named t/level/target/msg can never
  // overwrite the record's real metadata (it's dropped instead of corrupting the line).
  return JSON.stringify({
    ...safe.fields,
    t: safe.time,
    level: safe.level,
    target: safe.target,
    msg: safe.msg,
  });
}

export interface TracerOptions {
  /** Where records go. Default: format + write to process.stderr. */
  sink?: Sink;
  /** Target→rank filter. Default: built from `process.env.RC_LOG`. */
  filter?: Filter;
  /** Clock (ms). Injectable for deterministic tests. Default: Date.now. */
  now?: () => number;
}

function defaultSink(rec: TraceRecord): void {
  process.stderr.write(`${formatRecord(rec)}\n`);
}

class TracerImpl implements Tracer {
  readonly #target: string;
  readonly #bound: Fields;
  readonly #sink: Sink;
  readonly #filter: Filter;
  readonly #now: () => number;
  readonly #rank: number;

  constructor(target: string, bound: Fields, sink: Sink, filter: Filter, now: () => number) {
    this.#target = target;
    this.#bound = bound;
    this.#sink = sink;
    this.#filter = filter;
    this.#now = now;
    this.#rank = filter(target); // resolve once — the filter is fixed for a process
  }

  enabled(level: Level): boolean {
    return RANK[level] <= this.#rank;
  }

  #emit(level: Level, msg: string, fields?: Fields): void {
    if (!this.enabled(level)) return;
    this.#sink({
      level,
      target: this.#target,
      msg: redactTraceText(msg),
      fields: redactTraceFields(fields ? { ...this.#bound, ...fields } : this.#bound),
      time: this.#now(),
    });
  }

  error(msg: string, fields?: Fields): void {
    this.#emit("error", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.#emit("warn", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.#emit("info", msg, fields);
  }
  debug(msg: string, fields?: Fields): void {
    this.#emit("debug", msg, fields);
  }
  trace(msg: string, fields?: Fields): void {
    this.#emit("trace", msg, fields);
  }

  child(fields: Fields): Tracer {
    return new TracerImpl(
      this.#target,
      { ...this.#bound, ...fields },
      this.#sink,
      this.#filter,
      this.#now,
    );
  }
}

/** A tracer that emits nothing — the default when a component is constructed without one. */
export const NOOP_TRACER: Tracer = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return NOOP_TRACER;
  },
  enabled() {
    return false;
  },
};

/** Create a tracer for `target`. With no options it reads RC_LOG and writes to stderr. */
export function createTracer(target: string, opts: TracerOptions = {}): Tracer {
  const filter = opts.filter ?? buildFilter(process.env.RC_LOG);
  return new TracerImpl(target, {}, opts.sink ?? defaultSink, filter, opts.now ?? Date.now);
}

/**
 * Build a sink from the environment:
 *   • RC_LOG_FILE=path     POSIX only: append to an owned 0600 regular non-symlink file.
 *   • RC_LOG_FORMAT=json   one JSON object per line (UNclipped); else the human formatter.
 * Unsafe/insecure targets (and Windows, where Node cannot enforce that contract) warn once and drop
 * records. A file with json format is the on-disk capture; stderr human is the live view. Returns the
 * stderr human sink when nothing is configured.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): Sink {
  const fmt = env.RC_LOG_FORMAT === "json" ? formatRecordJson : formatRecord;
  const file = env.RC_LOG_FILE;
  if (file && file.trim() !== "") {
    const path = file;
    let warned = false;
    return (rec) => {
      const warnUnsafe = () => {
        if (warned) return;
        warned = true;
        process.stderr.write(
          "remote-claw: RC_LOG_FILE is not safely writable; trace records are being dropped\n",
        );
      };
      // Node does not expose a Windows equivalent of POSIX owner/mode + O_NOFOLLOW checks. Do not
      // silently make a weaker promise for credential-adjacent captures.
      if (process.platform === "win32" || !constants.O_NOFOLLOW) {
        warnUnsafe();
        return;
      }
      let fd: number | undefined;
      try {
        const flags =
          constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | constants.O_NOFOLLOW;
        let created = false;
        try {
          fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          fd = openSync(path, flags);
        }
        let stat = fstatSync(fd);
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
          throw new Error("capture target is not an owned regular file");
        }
        if (created) {
          fchmodSync(fd, 0o600);
          stat = fstatSync(fd);
        }
        if ((stat.mode & 0o777) !== 0o600) {
          throw new Error("existing capture permissions are not 0600");
        }
        writeFileSync(fd, `${fmt(rec)}\n`, "utf8");
      } catch {
        // A broken log file must never take down the process it's observing — drop the line.
        warnUnsafe();
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // Best-effort close after a failed write.
          }
        }
      }
    };
  }
  if (env.RC_LOG_FORMAT === "json")
    return (rec) => process.stderr.write(`${formatRecordJson(rec)}\n`);
  return defaultSink;
}

/** The conventional root tracer: filter from RC_LOG, sink from RC_LOG_FILE/RC_LOG_FORMAT. */
export function tracerFromEnv(target: string, env: NodeJS.ProcessEnv = process.env): Tracer {
  return createTracer(target, { filter: buildFilter(env.RC_LOG), sink: sinkFromEnv(env) });
}
