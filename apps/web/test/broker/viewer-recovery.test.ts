import { deriveIdentity, formatPass, type Identity, utf8 } from "@remote-claw/clawsec";
import { BrokerClient, securityProvider } from "@remote-claw/cli/broker";
import { teardownWorkflowTests } from "@workflow/vitest";
import { afterAll, describe, expect, it } from "vitest";
import { type Message, TRANSCRIPT_GAP_STALL_MS, Viewer } from "../../app/lib/viewer";
import { shouldShowGapRecovery } from "../../app/page";
import { brokerFetch, header } from "../e2e/harness";

afterAll(async () => {
  await teardownWorkflowTests();
});

function fakeHost(id: Identity): BrokerClient {
  return new BrokerClient({
    baseUrl: "http://broker",
    provider: securityProvider("sealed", id),
    fetchFn: brokerFetch,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await sleep(25);
  if (!pred()) throw new Error("timed out waiting for condition");
}

async function postAnnounce(
  host: BrokerClient,
  id: Identity,
  sid: string,
  incarnation: string,
): Promise<void> {
  await host.postFrame(
    header(id, {
      recordKind: "session_announce",
      sessionId: sid,
      msgId: `ann-${incarnation}`,
    }),
    utf8(
      JSON.stringify({
        session_id: sid,
        title: "rc box",
        cwd: "/work",
        sent_at: Date.now(),
        incarnation,
      }),
    ),
  );
}

async function postOut(
  host: BrokerClient,
  id: Identity,
  sid: string,
  seq: number,
  msgId: string,
  text: string,
): Promise<void> {
  await host.postFrame(
    header(id, { recordKind: "assistant", sessionId: sid, seq, msgId }),
    utf8(text),
  );
}

function durableSeqFailsOnceFetch(): typeof fetch {
  let failures = 1;
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/api/seq") {
      if (failures > 0) {
        failures--;
        return new Response(JSON.stringify({ error: "temporary seq failure" }), { status: 503 });
      }
      return new Response(JSON.stringify({ maxSeq: 0, durable: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return brokerFetch(input, init);
  }) as typeof fetch;
}

function failChunkFetch(msgId: string, part: number): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/api/relay" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { msg_id?: unknown; part?: unknown };
      if (body.msg_id === msgId && body.part === part) {
        return new Response(JSON.stringify({ error: "chunk failed" }), { status: 500 });
      }
    }
    return brokerFetch(input, init);
  }) as typeof fetch;
}

describe("Viewer transcript restart and gap recovery", () => {
  it("resets a live transcript across a non-durable host seq reset after a new incarnation announce", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(181));
    const host = fakeHost(id);
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const sid = "viewer-restart-orderer";
    const ac = new AbortController();
    const seenIncarnations: string[] = [];
    const got: Message[] = [];

    try {
      void (async () => {
        for await (const a of viewer.announces(ac.signal)) {
          if (a.sessionId === sid && a.incarnation !== null) seenIncarnations.push(a.incarnation);
        }
      })().catch(() => {});
      void (async () => {
        for await (const m of viewer.transcript(sid, ac.signal)) {
          if (m.kind !== "gap") got.push(m);
        }
      })().catch(() => {});

      await postAnnounce(host, id, sid, "inc-1");
      await waitFor(() => seenIncarnations.includes("inc-1"));
      await postOut(host, id, sid, 0, "old-0", "before restart 0");
      await postOut(host, id, sid, 1, "old-1", "before restart 1");
      await waitFor(() => got.some((m) => m.msgId === "old-1"));

      await postAnnounce(host, id, sid, "inc-2");
      await waitFor(() => seenIncarnations.includes("inc-2"));
      await sleep(250);
      await postOut(host, id, sid, 0, "new-0", "after restart 0");
      await postOut(host, id, sid, 1, "new-1", "after restart 1");
      await waitFor(() => got.some((m) => m.msgId === "new-1"));

      expect(got.map((m) => m.text)).toEqual([
        "before restart 0",
        "before restart 1",
        "after restart 0",
        "after restart 1",
      ]);
    } finally {
      ac.abort();
    }
  });

  it("keeps durable ordering across a restart when the first seqCursor probe fails", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(184));
    const host = fakeHost(id);
    const viewer = await Viewer.fromPass(
      await formatPass(id),
      "http://broker",
      durableSeqFailsOnceFetch(),
    );
    const sid = "viewer-durable-restart-flaky-seq";
    const ac = new AbortController();
    const seenIncarnations: string[] = [];
    const got: Message[] = [];

    try {
      void (async () => {
        for await (const a of viewer.announces(ac.signal)) {
          if (a.sessionId === sid && a.incarnation !== null) seenIncarnations.push(a.incarnation);
        }
      })().catch(() => {});
      void (async () => {
        for await (const m of viewer.transcript(sid, ac.signal)) {
          if (m.kind !== "gap") got.push(m);
        }
      })().catch(() => {});

      await postAnnounce(host, id, sid, "dur-inc-1");
      await waitFor(() => seenIncarnations.includes("dur-inc-1"));
      await postOut(host, id, sid, 0, "dur-old-0", "before durable restart");
      await waitFor(() => got.some((m) => m.msgId === "dur-old-0"));

      await postAnnounce(host, id, sid, "dur-inc-2");
      await waitFor(() => seenIncarnations.includes("dur-inc-2"));
      await postOut(host, id, sid, 1, "dur-new-1", "after durable restart");
      await waitFor(() => got.some((m) => m.msgId === "dur-new-1"));

      expect(got.map((m) => m.text)).toEqual(["before durable restart", "after durable restart"]);
    } finally {
      ac.abort();
    }
  });

  it("surfaces a permanent low-seq gap and the page helper marks it recoverable after the bounded stall", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(182));
    const host = fakeHost(id);
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const sid = "viewer-gap-surfacing";
    const ac = new AbortController();

    try {
      await postOut(host, id, sid, 1, "gap-1", "seq 1");
      await postOut(host, id, sid, 2, "gap-2", "seq 2");

      let gap: Message | undefined;
      for await (const m of viewer.transcript(sid, ac.signal)) {
        if (m.kind === "gap") {
          gap = m;
          break;
        }
      }

      expect(gap).toMatchObject({ kind: "gap", nextSeq: 0, pending: 1 });
      const since = gap?.since ?? 0;
      expect(
        shouldShowGapRecovery(
          { nextSeq: 0, pending: gap?.pending ?? 0, since },
          since + TRANSCRIPT_GAP_STALL_MS - 1,
        ),
      ).toBe(false);
      expect(
        shouldShowGapRecovery(
          { nextSeq: 0, pending: gap?.pending ?? 0, since },
          since + TRANSCRIPT_GAP_STALL_MS,
        ),
      ).toBe(true);
    } finally {
      ac.abort();
    }
  });

  it("surfaces an incomplete chunked cursor slot through gap recovery", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(185));
    const sid = "viewer-partial-chunk-gap";
    const msgId = "partial-big";
    const host = new BrokerClient({
      baseUrl: "http://broker",
      provider: securityProvider("sealed", id),
      fetchFn: failChunkFetch(msgId, 1),
    });
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const ac = new AbortController();

    try {
      await expect(
        host.postMessage(
          header(id, { recordKind: "assistant", sessionId: sid, seq: 0, msgId }),
          utf8("chunk ".repeat(1000)),
          2000,
        ),
      ).rejects.toThrow();

      let gap: Message | undefined;
      for await (const m of viewer.transcript(sid, ac.signal)) {
        if (m.kind === "gap") {
          gap = m;
          break;
        }
      }

      expect(gap).toMatchObject({ kind: "gap", nextSeq: 0, pending: 1 });
      const since = gap?.since ?? 0;
      expect(
        shouldShowGapRecovery(
          { nextSeq: 0, pending: gap?.pending ?? 0, since },
          since + TRANSCRIPT_GAP_STALL_MS,
        ),
      ).toBe(true);
    } finally {
      ac.abort();
    }
  });

  it("delivers seq-null permission_resolved while a content gap is open", async () => {
    const id = await deriveIdentity(new Uint8Array(32).fill(183));
    const host = fakeHost(id);
    const viewer = await Viewer.fromPass(await formatPass(id), "http://broker", brokerFetch);
    const sid = "viewer-permission-resolved-gap";
    const ac = new AbortController();

    try {
      await postOut(host, id, sid, 1, "blocked-1", "seq 1 waits for missing seq 0");
      await host.postFrame(
        header(id, {
          recordKind: "permission_resolved",
          sessionId: sid,
          seq: null,
          msgId: "resolved-gap",
        }),
        utf8(JSON.stringify({ request_id: "perm-gap", behavior: "allow" })),
      );

      let sawGap = false;
      let resolved: Message | undefined;
      for await (const m of viewer.transcript(sid, ac.signal)) {
        if (m.kind === "gap") sawGap = true;
        if (m.kind === "permission_resolved") {
          resolved = m;
          break;
        }
      }

      expect(sawGap).toBe(true);
      expect(resolved).toMatchObject({
        kind: "permission_resolved",
        seq: null,
        text: JSON.stringify({ request_id: "perm-gap", behavior: "allow" }),
      });
    } finally {
      ac.abort();
    }
  });
});
