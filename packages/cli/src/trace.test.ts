import { chmodSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFilter,
  createTracer,
  formatRecord,
  formatRecordJson,
  NOOP_TRACER,
  redactJsonTraceBody,
  redactTraceText,
  sinkFromEnv,
  TRACE_REDACTED,
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

describe("trace credential redaction", () => {
  it("walks nested JSON and handles snake_case, camelCase, headers, and token-shaped text", () => {
    const compactJwt = [`eyJ${"a".repeat(12)}`, "b".repeat(12), "c".repeat(12)].join(".");
    const body = JSON.stringify({
      worker_jwt: "worker-jwt-canary",
      nested: [
        {
          accessToken: "access-token-canary",
          refresh_token: "refresh-token-canary",
          safe: "ordinary transcript text",
        },
      ],
      headers: {
        Authorization: "Bearer authorization-canary",
        "Set-Cookie": "rc_token=cookie-canary",
      },
      text: `Bearer embedded-bearer-canary sk-ant-oat01-anthropiccanary ${compactJwt}`,
    });

    const redacted = redactJsonTraceBody(body);
    for (const secret of [
      "worker-jwt-canary",
      "access-token-canary",
      "refresh-token-canary",
      "authorization-canary",
      "cookie-canary",
      "embedded-bearer-canary",
      "sk-ant-oat01-anthropiccanary",
      compactJwt,
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("ordinary transcript text");
    expect(redacted).toContain(TRACE_REDACTED);
  });

  it("fails closed for malformed JSON-looking protocol bodies", () => {
    const malformed = '{"worker_jwt":"opaque-canary"';
    const redacted = redactJsonTraceBody(malformed);
    expect(redacted).toContain("REDACTION_FAILED");
    expect(redacted).toContain(`bytes=${Buffer.byteLength(malformed)}`);
    expect(redacted).not.toContain("opaque-canary");
    expect(redactTraceText(malformed)).toBe(redacted);
  });

  it("uses one conservative rule for uncommon credential keys, text pairs, and whole cookies", () => {
    const secrets = {
      apiKey: "acronym-api-key-canary",
      token: "generic-token-canary",
      setup: "new-setup-token-canary",
      password: "database-password-canary",
      bypass: "vercel-bypass-canary",
      auth: "generic-auth-canary",
      authentication: "authentication-canary",
      awsSecret: "aws-secret-canary",
      tokenKey: "sk-ant-oat01-key-name-canary",
      looseToken: "loose-token-pair-canary",
      loosePassword: "loose-password-pair-canary",
      embeddedJson: "embedded-json-token-canary",
      prefixedAuth: "prefixed-json-auth-canary",
      prefixedAws: "prefixed-json-aws-canary",
      malformedApiKey: "malformed-json-api-key-canary",
      secretKey: "secret-key-canary",
      multilineCredentials: "multiline-credentials-canary",
      multilineAuth: "multiline-auth-canary",
      digestResponse: "digest-response-canary",
      awsSignature: "aws-signature-canary",
      cookieOne: "first-cookie-canary",
      cookieTwo: "second-cookie-canary",
    };
    const json = redactJsonTraceBody(
      JSON.stringify({
        APIKey: secrets.apiKey,
        opaqueToken: secrets.token,
        newSetupToken: secrets.setup,
        databasePassword: secrets.password,
        xVercelProtectionBypass: secrets.bypass,
        auth: secrets.auth,
        authentication: secrets.authentication,
        AWS_SECRET_ACCESS_KEY: secrets.awsSecret,
        secretKey: secrets.secretKey,
        [secrets.tokenKey]: "value",
      }),
    );
    const text = redactTraceText(
      [
        `token=${secrets.looseToken}`,
        `password=${secrets.loosePassword}`,
        `auth=${secrets.auth}`,
        `authentication=${secrets.authentication}`,
        `AWS_SECRET_ACCESS_KEY=${secrets.awsSecret}`,
        `response contained {"opaqueToken":"${secrets.embeddedJson}"}`,
        `response body: {"auth":"${secrets.prefixedAuth}"}`,
        `error payload={"AWS_SECRET_ACCESS_KEY":"${secrets.prefixedAws}"}`,
        `malformed payload={"api_key":"${secrets.malformedApiKey}"`,
        `diagnostic secretKey=${secrets.secretKey}`,
        `Cookie: a=${secrets.cookieOne}; b=${secrets.cookieTwo}`,
        `Authorization: Digest realm="x", response="${secrets.digestResponse}"`,
        `Proxy-Authorization: AWS4-HMAC-SHA256 Credential=x, Signature=${secrets.awsSignature}`,
      ].join("\n"),
    );
    const multiline = [
      redactTraceText(
        `stream error: {\n  "credentials": [\n    "${secrets.multilineCredentials}"\n  ]\n}`,
      ),
      redactTraceText(
        `stream error: {\n  "auth": {\n    "value": "${secrets.multilineAuth}"\n  }\n}`,
      ),
    ].join("\n");
    const rendered = `${json}\n${text}\n${multiline}`;
    for (const secret of Object.values(secrets)) expect(rendered).not.toContain(secret);
    expect(rendered).toContain(TRACE_REDACTED);
  });

  it("sanitizes messages and fields before a custom sink receives them", () => {
    const { t, recs } = capture("rc.mitm", "trace");
    t.trace("Authorization: Bearer message-canary", {
      worker_jwt: "field-worker-canary",
      "sk-ant-oat01-dynamic-field-key-canary": "ordinary value",
      body: JSON.stringify({
        access_token: "body-access-canary",
        text: "safe body content",
      }),
    });
    const captured = JSON.stringify(recs);
    expect(captured).not.toContain("message-canary");
    expect(captured).not.toContain("field-worker-canary");
    expect(captured).not.toContain("sk-ant-oat01-dynamic-field-key-canary");
    expect(captured).not.toContain("body-access-canary");
    expect(captured).toContain("safe body content");
    expect(captured).toContain(TRACE_REDACTED);
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

  it("redacts direct formatter input as a final sink boundary", () => {
    const obj = JSON.parse(
      formatRecordJson({
        level: "trace",
        target: "rc.mitm",
        msg: "bridge",
        fields: { worker_jwt: "formatter-canary" },
        time: 5,
      }),
    );
    expect(obj.worker_jwt).toBe(TRACE_REDACTED);
    expect(JSON.stringify(obj)).not.toContain("formatter-canary");
  });
});

describe.skipIf(process.platform === "win32")("sinkFromEnv secure files", () => {
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

  it("creates a capture as 0600 and appends to an owned existing 0600 file", () => {
    const fresh = tmp("mode-new");
    const freshSink = sinkFromEnv({ RC_LOG_FILE: fresh } as NodeJS.ProcessEnv);
    freshSink({ level: "info", target: "rc.mitm", msg: "new", fields: {}, time: 0 });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);

    const existingSink = sinkFromEnv({ RC_LOG_FILE: fresh } as NodeJS.ProcessEnv);
    existingSink({ level: "info", target: "rc.mitm", msg: "again", fields: {}, time: 0 });
    const appended = readFileSync(fresh, "utf8");
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    expect(appended).toContain("INFO  rc.mitm new");
    expect(appended).toContain("INFO  rc.mitm again");
  });

  it("refuses a permissive existing capture instead of repairing and appending", () => {
    const existing = tmp("mode-existing");
    writeFileSync(existing, "old\n", { mode: 0o644 });
    chmodSync(existing, 0o644);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sink = sinkFromEnv({ RC_LOG_FILE: existing } as NodeJS.ProcessEnv);
      sink({ level: "info", target: "rc.mitm", msg: "must not append", fields: {}, time: 0 });
      sink({ level: "info", target: "rc.mitm", msg: "still not", fields: {}, time: 0 });
      expect(statSync(existing).mode & 0o777).toBe(0o644);
      expect(readFileSync(existing, "utf8")).toBe("old\n");
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it("refuses a non-regular capture target", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sink = sinkFromEnv({ RC_LOG_FILE: "/dev/null" } as NodeJS.ProcessEnv);
      sink({ level: "info", target: "rc.mitm", msg: "must not write", fields: {}, time: 0 });
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it("refuses to follow a symlink capture target", () => {
    const target = tmp("symlink-target");
    const link = tmp("symlink-link");
    writeFileSync(target, "unchanged\n", { mode: 0o600 });
    symlinkSync(target, link);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sink = sinkFromEnv({ RC_LOG_FILE: link } as NodeJS.ProcessEnv);
      sink({ level: "info", target: "rc.mitm", msg: "must not append", fields: {}, time: 0 });
      sink({ level: "info", target: "rc.mitm", msg: "still not", fields: {}, time: 0 });
      expect(readFileSync(target, "utf8")).toBe("unchanged\n");
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it("a broken log path never throws (drops the line)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sink = sinkFromEnv({ RC_LOG_FILE: "/no/such/dir/x.log" } as NodeJS.ProcessEnv);
      expect(() =>
        sink({ level: "error", target: "t", msg: "m", fields: {}, time: 0 }),
      ).not.toThrow();
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
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

describe.skipIf(process.platform !== "win32")("sinkFromEnv on Windows", () => {
  it("warns once and drops RC_LOG_FILE records when POSIX safety cannot be guaranteed", () => {
    const file = join(tmpdir(), `rc-trace-win-${process.pid}.log`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sink = sinkFromEnv({ RC_LOG_FILE: file } as NodeJS.ProcessEnv);
      sink({ level: "info", target: "rc.mitm", msg: "drop", fields: {}, time: 0 });
      sink({ level: "info", target: "rc.mitm", msg: "drop again", fields: {}, time: 0 });
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
      rmSync(file, { force: true });
    }
  });
});
