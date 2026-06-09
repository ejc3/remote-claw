// Deployment-targeted e2e: exercises the REAL broker running on a Vercel deployment over HTTP,
// rather than the in-process Workflow runtime. Mirrors the bus + per-session relay round-trips of
// broker.integration.test.ts, but against `WEB_E2E_URL` (the preview/prod URL). Skipped when that
// env var is unset, so a normal local/CI run stays green; the web-preview CI job sets it to the
// Vercel preview URL once the deployment is ready.
//
// Each run uses a FRESH RANDOM identity, so it gets its own per-identity bus/session channels — no
// cross-run interference on the shared deployment, and startIndex=0 reads exactly our own frames.

import {
  decodeFrame,
  deriveIdentity,
  deriveSessionKey,
  open,
  utf8,
  type WireFrame,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { announceFrame, bearer, header, readSseData, wireFrame } from "../helpers";

const BASE = process.env.WEB_E2E_URL?.replace(/\/+$/, "");
const td = new TextDecoder();

function freshIdentity() {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return deriveIdentity(secret);
}

describe.skipIf(!BASE)("deployed broker e2e (WEB_E2E_URL)", () => {
  it("a sealed bus announce round-trips host → POST /api/relay → bus → GET /api/stream → open", async () => {
    const id = await freshIdentity();
    const auth = bearer(id.authToken);
    const frame = await announceFrame(id, {
      session_id: "preview-sess",
      title: "preview-host",
      sent_at: 1,
    });

    const pub = await fetch(`${BASE}/api/relay`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(frame),
    });
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ ok: true, channel: "bus" });

    const res = await fetch(`${BASE}/api/stream?startIndex=0`, {
      headers: { authorization: auth, accept: "text/event-stream" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const [received] = (await readSseData(res, 1)) as [WireFrame];
    // The deployed broker forwarded ciphertext verbatim; only the K_meta holder can read it.
    const plaintext = await open(id.kMeta, decodeFrame(received));
    expect(JSON.parse(td.decode(plaintext))).toMatchObject({ title: "preview-host" });
  });

  it("a per-session content frame rides the session channel, not the bus", async () => {
    const id = await freshIdentity();
    const auth = bearer(id.authToken);
    const sid = "preview-sess-A";
    const kSession = await deriveSessionKey(id.contentRoot, sid);
    const frame = await wireFrame(
      kSession,
      header(id, { sessionId: sid, recordKind: "assistant", seq: 0, dir: "out" }),
      utf8("hello from a deployed claude"),
    );

    const pub = await fetch(`${BASE}/api/relay?session=${encodeURIComponent(sid)}`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(frame),
    });
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ ok: true, channel: "session" });

    const onSession = await readSseData(
      await fetch(`${BASE}/api/stream?session=${encodeURIComponent(sid)}&startIndex=0`, {
        headers: { authorization: auth, accept: "text/event-stream" },
      }),
      1,
    );
    expect(td.decode(await open(kSession, decodeFrame(onSession[0] as WireFrame)))).toBe(
      "hello from a deployed claude",
    );

    // The identity BUS never saw the per-session frame (no bus run → 200 empty event-stream).
    const onBus = await readSseData(
      await fetch(`${BASE}/api/stream?startIndex=0`, {
        headers: { authorization: auth, accept: "text/event-stream" },
      }),
      1,
    );
    expect(onBus).toEqual([]);
  });
});
