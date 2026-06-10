import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFilter,
  createTracer,
  formatRecord,
  formatRecordJson,
  NOOP_TRACER,
  sinkFromEnv,
  type TraceRecord,
  tracerFromEnv,
} from "./trace.js";

/** A capturing sink + a tracer wired to it with a fixed clock, for assertions. */
function capture(target: string, spec: string | undefined) {
  const recs: TraceRecord[] = [];
  const t = createTracer(target, {
    sink: (r) => recs.push(r),
    filter: buildFilter(spec),
    now: () => 0,
  });
  return { t, recs };
}

describe("buildFilter", () => {
  it("defaults to warn when RC_LOG is unset/empty", () => {
    for (const spec of [undefined, "", "   "]) {
      const f = buildFilter(spec);
      expect(f("rc.relay")).toBe(1); // warn
    }
  });

  it("a bare level sets the global default", () => {
    const f = buildFilter("debug");
    expect(f("rc.relay")).toBe(3);
    expect(f("anything")).toBe(3);
  });

  it("target=level scopes a target; longest dot-prefix wins", () => {
    const f = buildFilter("warn,rc=info,rc.mitm=trace");
    expect(f("rc.session")).toBe(2); // matched by rc=info
    expect(f("rc.mitm")).toBe(4); // more specific rc.mitm=trace wins
    expect(f("other")).toBe(1); // global warn
  });

  it("naming a target with no global default silences the rest (OFF)", () => {
    const f = buildFilter("rc.mitm=debug");
    expect(f("rc.mitm")).toBe(3);
    expect(f("rc.relay")).toBe(-1); // OFF
  });

  it("supports an explicit off directive", () => {
    const f = buildFilter("info,rc.mitm=off");
    expect(f("rc.mitm")).toBe(-1);
    expect(f("rc.relay")).toBe(2);
  });

  it("dot-prefix must align to a segment boundary", () => {
    const f = buildFilter("rc.mitm=trace"); // must not match "rc.mitmx"
    expect(f("rc.mitmx")).toBe(-1);
    expect(f("rc.mitm")).toBe(4);
  });

  it("a garbled/typo'd spec falls back to warn (never silences errors)", () => {
    // No valid directive parsed → must NOT default to OFF, or a typo would hide warnings + errors.
    for (const spec of ["rc.mitm", ",", "nonsense", "=debug", "rc.mitm="]) {
      expect(buildFilter(spec)("rc.relay")).toBe(1); // warn
    }
    // But a VALID target rule with no global default does silence the rest (intentional scoping).
    expect(buildFilter("rc.mitm=debug")("rc.relay")).toBe(-1);
  });
});

describe("Tracer level gating", () => {
  it("emits at and above the target level, drops below", () => {
    const { t, recs } = capture("rc.relay", "rc.relay=info");
    t.trace("t");
    t.debug("d");
    t.info("i");
    t.warn("w");
    t.error("e");
    expect(recs.map((r) => r.level)).toEqual(["info", "warn", "error"]);
  });

  it("enabled() mirrors what would be emitted", () => {
    const { t } = capture("rc.relay", "warn");
    expect(t.enabled("error")).toBe(true);
    expect(t.enabled("warn")).toBe(true);
    expect(t.enabled("info")).toBe(false);
  });
});

describe("child fields", () => {
  it("binds fields onto every record and merges call-site fields (call-site wins)", () => {
    const { t, recs } = capture("rc.relay", "debug");
    const child = t.child({ session: "abc123" });
    child.info("frame sealed", { kind: "assistant", seq: 4 });
    child.info("override", { session: "xyz" });
    expect(recs[0]?.fields).toEqual({ session: "abc123", kind: "assistant", seq: 4 });
    expect(recs[1]?.fields).toEqual({ session: "xyz" });
  });

  it("a disabled level skips the sink entirely", () => {
    const { t, recs } = capture("rc.relay", "warn");
    t.child({ session: "s" }).debug("noisy", { big: "x".repeat(10_000) });
    expect(recs).toHaveLength(0);
  });
});

describe("formatRecord", () => {
  it("renders ts, padded level, target, msg, and key=val fields", () => {
    const line = formatRecord({
      level: "info",
      target: "rc.relay",
      msg: "frame sealed",
      fields: { kind: "assistant", seq: 4, bytes: 812 },
      time: 0,
    });
    expect(line).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d INFO {2}rc\.relay frame sealed/);
    expect(line).toContain("kind=assistant seq=4 bytes=812");
  });

  it("quotes fields with spaces/equals and truncates very long values", () => {
    const line = formatRecord({
      level: "warn",
      target: "t",
      msg: "m",
      fields: { note: "has space", long: "y".repeat(500) },
      time: 0,
    });
    expect(line).toContain('note="has space"');
    expect(line).toContain("…"); // long value clipped
    expect(line).not.toContain("y".repeat(200));
  });
});

describe("NOOP_TRACER", () => {
  it("emits nothing and is never enabled", () => {
    expect(NOOP_TRACER.enabled("error")).toBe(false);
    NOOP_TRACER.error("should not throw");
    expect(NOOP_TRACER.child({ a: 1 })).toBe(NOOP_TRACER);
  });
});

describe("formatRecordJson", () => {
  it("emits one unclipped JSON object per record", () => {
    const long = "z".repeat(500);
    const obj = JSON.parse(
      formatRecordJson({
        level: "debug",
        target: "rc.relay",
        msg: "user prompt",
        fields: { seq: 3, text: long },
        time: 123,
      }),
    );
    expect(obj).toMatchObject({
      t: 123,
      level: "debug",
      target: "rc.relay",
      msg: "user prompt",
      seq: 3,
    });
    expect(obj.text).toBe(long); // on-disk capture is NOT clipped
  });

  it("a field named like a canonical key cannot overwrite the record metadata", () => {
    const obj = JSON.parse(
      formatRecordJson({
        level: "warn",
        target: "rc.relay",
        msg: "real msg",
        fields: { level: "SPOOF", target: "SPOOF", msg: "SPOOF", t: 999 },
        time: 5,
      }),
    );
    expect(obj).toMatchObject({ level: "warn", target: "rc.relay", msg: "real msg", t: 5 });
  });
});

describe("sinkFromEnv", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const f of files.splice(0)) rmSync(f, { force: true });
  });
  const tmp = (name: string) => {
    const p = join(tmpdir(), `rc-trace-${name}-${process.pid}.log`);
    files.push(p);
    return p;
  };

  it("appends human lines to RC_LOG_FILE", () => {
    const file = tmp("human");
    const sink = sinkFromEnv({ RC_LOG_FILE: file } as NodeJS.ProcessEnv);
    sink({
      level: "info",
      target: "rc.mitm",
      msg: "session created",
      fields: { session: "s1" },
      time: 0,
    });
    sink({ level: "warn", target: "rc.mitm", msg: "uh oh", fields: {}, time: 0 });
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("INFO  rc.mitm session created session=s1");
  });

  it("writes JSON lines when RC_LOG_FORMAT=json", () => {
    const file = tmp("json");
    const sink = sinkFromEnv({ RC_LOG_FILE: file, RC_LOG_FORMAT: "json" } as NodeJS.ProcessEnv);
    sink({ level: "debug", target: "rc.relay", msg: "frame sealed", fields: { seq: 1 }, time: 7 });
    const obj = JSON.parse(readFileSync(file, "utf8").trim());
    expect(obj).toMatchObject({
      level: "debug",
      target: "rc.relay",
      msg: "frame sealed",
      seq: 1,
      t: 7,
    });
  });

  it("a broken log path never throws (drops the line)", () => {
    const sink = sinkFromEnv({ RC_LOG_FILE: "/no/such/dir/x.log" } as NodeJS.ProcessEnv);
    expect(() =>
      sink({ level: "error", target: "t", msg: "m", fields: {}, time: 0 }),
    ).not.toThrow();
  });

  it("tracerFromEnv honors RC_LOG and the file sink together", () => {
    const file = tmp("env");
    const t = tracerFromEnv("rc.relay", {
      RC_LOG: "rc.relay=debug",
      RC_LOG_FILE: file,
    } as NodeJS.ProcessEnv);
    t.debug("kept", { seq: 1 });
    t.trace("dropped below debug");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kept");
  });
});
