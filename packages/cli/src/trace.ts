// A tiny structured tracer — Rust `tracing` in spirit, sized for one CLI. It is:
//   • leveled       error < warn < info < debug < trace
//   • target-scoped each call site names a target ("rc.relay", "rc.mitm", "rc.session", …)
//   • env-filtered  RC_LOG selects what's emitted, RUST_LOG-style ("debug", "rc.mitm=debug,warn")
//   • span-like     child() binds fields (e.g. { session }) onto every line beneath it
//   • local-only    the default sink is stderr; it never reaches the broker, --rc-json, or stdout
//     (the secret-leak surfaces, see secretleak.ts). This runs on the SAME machine that already holds
//     the raw transcript, so logging conversation content/titles is not a leak — be pragmatic, not
//     paranoid. The one hard rule: NEVER pass key material (the AEAD/session keys, the rc master
//     secret) to a trace call. Content rides at debug+, and `trace` is the unclipped firehose.
//
// Off by default for everything below `warn`, so a normal run is quiet (signal/noise, not secrecy);
// opt into diagnosis with `RC_LOG=debug` (all) or `RC_LOG=rc.relay=trace,rc.mitm=debug` (per target).

import { appendFileSync } from "node:fs";

export type Level = "error" | "warn" | "info" | "debug" | "trace";

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const OFF = -1;

/** A structured field value. Deliberately scalar-only: you cannot log an object/body wholesale. */
export type Field = string | number | boolean | null | undefined;
export type Fields = Record<string, Field>;

/** One emitted record, handed to a sink. The default sink formats it; tests can capture it raw. */
export interface TraceRecord {
  level: Level;
  target: string;
  msg: string;
  fields: Fields;
  time: number;
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
  const d = new Date(rec.time);
  const ts = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${three(d.getMilliseconds())}`;
  const lvl = rec.level.toUpperCase().padEnd(5);
  // `trace` is the deliberate firehose — show full bodies; info/debug clip long fields for the eye.
  const clipLong = rec.level !== "trace";
  let line = `${ts} ${lvl} ${rec.target} ${rec.msg}`;
  for (const [k, v] of Object.entries(rec.fields)) line += ` ${k}=${fmtField(v, clipLong)}`;
  return line;
}

/** Machine formatter: one JSON object per line, fields UNclipped — for a full on-disk capture you can
 *  grep/replay later (RC_LOG_FORMAT=json + RC_LOG_FILE). Still scalar fields only; never secrets. */
export function formatRecordJson(rec: TraceRecord): string {
  // Canonical keys are spread LAST so a field that happens to be named t/level/target/msg can never
  // overwrite the record's real metadata (it's dropped instead of corrupting the line).
  return JSON.stringify({
    ...rec.fields,
    t: rec.time,
    level: rec.level,
    target: rec.target,
    msg: rec.msg,
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
      msg,
      fields: fields ? { ...this.#bound, ...fields } : this.#bound,
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
 *   • RC_LOG_FILE=path     append records to that file (created if absent), instead of stderr.
 *   • RC_LOG_FORMAT=json   one JSON object per line (UNclipped); else the human formatter.
 * A file with json format is the full on-disk capture; stderr human is the live view. Returns the
 * stderr human sink when nothing is configured.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): Sink {
  const fmt = env.RC_LOG_FORMAT === "json" ? formatRecordJson : formatRecord;
  const file = env.RC_LOG_FILE;
  if (file && file.trim() !== "") {
    const path = file;
    return (rec) => {
      try {
        appendFileSync(path, `${fmt(rec)}\n`);
      } catch {
        // A broken log file must never take down the process it's observing — drop the line.
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
