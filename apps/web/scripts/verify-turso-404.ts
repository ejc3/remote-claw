// REAL reproduction of the Turso Cloud "create→serve" 404 race + verification of the awaitReady fix —
// against a LIVE Turso account, using the SHIPPED TursoCloudDbLocator (no simulation, no injected errors).
//
// Run:  TURSO_API_TOKEN=… TURSO_ORG=… TURSO_GROUP=… TURSO_GROUP_AUTH_TOKEN=… \
//         pnpm --filter @remote-claw/web exec tsx scripts/verify-turso-404.ts [N]
//   (missing credentials are INCONCLUSIVE with exit 2; a declared live gate never skips green.)
//
// The bug (seen live on a Vercel preview, default backend = per-session Turso Cloud): the Platform-API
// `POST /databases` returns 200, and a control-plane `GET /databases/{name}` reports the db within ~100ms —
// but the new db's libSQL DATA-PLANE endpoint does not serve for hundreds of ms (seconds, cross-region)
// afterwards. So a query in that window throws `LibsqlError: SERVER_ERROR: Server returned HTTP status 404`
// (cause HttpServerError status 404).
//
// Why it bites the broker: every acquire() (publish, subscribe, frameCount) goes through awaitReady, so
// the gate protects all paths. The window most reliably BITES the cold read path — subscribe()/frameCount()
// (acquire create:false) run on a SEPARATE serverless instance whose exists() GET returns 200 (control
// plane) and which then connects INTO the window — whereas the creating instance's own first query usually
// lands after serve. This harness targets that cold read race exactly:
//   • a "publisher" locator instance ensure()s the db (the create),
//   • a SEPARATE "subscriber" locator instance (its own cold #known cache, like another instance) races it,
//     polling exists() and connecting the instant the control plane reports the db:
//       – Phase 1, WITHOUT the gate (raw query)            → SERVE_GAP_404   (the production fingerprint)
//       – Phase 2, WITH the shipped awaitReady() gate       → served, and we measure awaitReady's OWN wait
//         AND whether the create→serve window was actually OPEN at connect time, so a "served" result can't
//         pass off a no-op (already-serving) connect as the gate having absorbed anything.
//
// Exit codes: 0 = healthy (awaitReady absorbed at least one observed open window); 1 = REGRESSION (a
// query still 404'd or readiness timed out AFTER awaitReady); 2 = INCONCLUSIVE (missing credentials,
// no exercised Phase-2 window, or never reached the data plane).
import { type Client, createClient } from "@libsql/client";
import { TursoCloudDbLocator, TursoReadinessTimeoutError } from "../lib/broker/turso-cloud-locator";

function parseN(arg: string | undefined): number {
  const p = Number.parseInt(arg ?? "8", 10);
  return Number.isFinite(p) ? Math.min(Math.max(p, 1), 50) : 8;
}
const N = parseN(process.argv[2]);

// Walk the WHOLE cause chain for an HTTP status (mirrors the locator's statusInCause), then fall back to the
// libSQL message fingerprint — so a 404 nested deeper than one cause level is still detected (the shallow
// `e.cause?.status` check the first draft used could miss it).
function statusInCause(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let i = 0; cur != null && i < 10; i++) {
    const s = (cur as { status?: unknown }).status;
    if (typeof s === "number") return s;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
function isServeGap404(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return statusInCause(e) === 404 || /Server returned HTTP status 404/.test(msg);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);
const tokenFor = (i: number): string =>
  `sess:${i.toString(16).padStart(32, "0")}:cse_verify404_${Math.random().toString(16).slice(2, 8)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const fmtMs = (n: number): string => (n < 0 ? "never" : `${n}ms`);

type RaceResult<T> = {
  result: "served" | "SERVE_GAP_404" | "READINESS_TIMEOUT" | "other" | "exists_timeout";
  value?: T;
  connectAtMs: number;
  detail?: string;
};

// Race a cold SUBSCRIBE against the create, exactly like the broker: fire publisher.ensure() (the create)
// and CONCURRENTLY poll subscriber.exists(); the instant the control plane reports the db (~100ms), run
// `attempt` against a fresh client ONCE — connecting INTO the create→serve window. (Awaiting ensure() fully
// and only THEN connecting misses the window, because the data plane catches up within a few hundred ms;
// the broker hits it precisely because subscribe polls DURING publish.) Returns the outcome + attempt value.
async function raceSubscribe<T>(
  publisher: TursoCloudDbLocator,
  subscriber: TursoCloudDbLocator,
  token: string,
  attempt: (client: Client) => Promise<T>,
): Promise<RaceResult<T>> {
  const start = Date.now();
  let out: RaceResult<T> = { result: "exists_timeout", connectAtMs: -1 };
  const racer = (async () => {
    while (Date.now() - start < 20_000) {
      if (await subscriber.exists(token)) {
        const connectAtMs = Date.now() - start;
        const client = createClient(subscriber.config(token));
        try {
          out = { result: "served", value: await attempt(client), connectAtMs };
        } catch (e) {
          out = isServeGap404(e)
            ? { result: "SERVE_GAP_404", connectAtMs }
            : e instanceof TursoReadinessTimeoutError
              ? { result: "READINESS_TIMEOUT", connectAtMs, detail: errMsg(e) }
              : { result: "other", connectAtMs, detail: errMsg(e) };
        } finally {
          client.close();
        }
        return;
      }
      await sleep(10);
    }
  })();
  try {
    await publisher.ensure(token); // the create — races the subscriber's exists() poll above
  } catch (e) {
    await racer.catch(() => {}); // drain the detached racer so it cannot unhandled-reject, then surface ensure's error
    throw e;
  }
  await racer;
  return out;
}

async function main(): Promise<void> {
  const apiToken = process.env.TURSO_API_TOKEN;
  const org = process.env.TURSO_ORG;
  const group = process.env.TURSO_GROUP;
  const authToken = process.env.TURSO_GROUP_AUTH_TOKEN;
  if (!apiToken || !org || !group || !authToken) {
    console.error(
      "INCONCLUSIVE: set TURSO_API_TOKEN / TURSO_ORG / TURSO_GROUP / TURSO_GROUP_AUTH_TOKEN to run the required live gate.",
    );
    process.exit(2);
  }

  // A throwaway scope makes every generated database easy to identify in the output. It is not
  // deletion authority: prefix ownership cannot be proved from a name, so this script never sweeps it.
  const scope = `v404-${Math.random().toString(16).slice(2, 8)}`;
  const opts = { apiToken, org, group, authToken, scope };
  // Two SEPARATE instances → two SEPARATE #known caches, i.e. a publishing instance and a cold subscribing
  // instance (exactly the broker's cross-instance shape). The subscriber's exists() does a real GET.
  const publisher = new TursoCloudDbLocator(opts);
  const subscriber = new TursoCloudDbLocator(opts);

  console.log(
    "=== Turso Cloud create→serve 404 — LIVE reproduction + awaitReady fix verification ===",
  );
  console.log(`org=${org} group=${group} scope=${scope} iterations=${N}\n`);

  let reproduced = 0; // Phase 1: raw connect hit SERVE_GAP_404
  let servedRaw = 0; // Phase 1: raw connect served (window already closed)
  let infra1 = 0; // Phase 1: never reached the data plane (other/exists_timeout)
  let fixServed = 0; // Phase 2: served via awaitReady
  let fixExercised = 0; // Phase 2: ...AND the window was actually OPEN at connect (gate genuinely absorbed it)
  let fixWaitTotalMs = 0; // Phase 2: sum of awaitReady's OWN wait over the exercised cases
  let fixRegressed = 0; // Phase 2: query STILL 404'd after awaitReady (genuine regression)
  let fixInfra = 0; // Phase 2: never reached the data plane (other/exists_timeout)

  // ---- Phase 1: reproduce (cold subscribe races the create, connects raw, no gate) -------------------
  console.log(
    "[Phase 1 — reproduce]  a COLD subscriber races publisher.ensure() and connects WITHOUT the gate:",
  );
  for (let i = 0; i < N; i++) {
    const token = tokenFor(i);
    const r = await raceSubscribe(publisher, subscriber, token, (c) => c.execute("SELECT 1"));
    if (r.result === "SERVE_GAP_404") reproduced++;
    else if (r.result === "served") servedRaw++;
    else infra1++;
    console.log(
      `  #${String(i + 1).padStart(2)} ${subscriber.idFor(token)}  connect@${fmtMs(r.connectAtMs)} → ${r.result}${r.detail ? ` (${r.detail})` : ""}`,
    );
  }

  // ---- Phase 2: verify the fix (race the create, probe whether the window is OPEN, then gate) ---------
  console.log(
    "\n[Phase 2 — verify fix]  same race; probe if the window is OPEN, then gate the connect on awaitReady():",
  );
  for (let i = 0; i < N; i++) {
    const token = tokenFor(1000 + i);
    const r = await raceSubscribe(publisher, subscriber, token, async (c) => {
      // Is the create→serve window OPEN right now? (a raw query would 404). This makes a "served" result
      // honest: it distinguishes "the gate absorbed a real window" from "the db was already serving".
      let windowOpen = false;
      try {
        await c.execute("SELECT 1");
      } catch (e) {
        if (isServeGap404(e)) windowOpen = true;
        else throw e; // a non-404 error (auth/network) is infra, not the window
      }
      // The SHIPPED fix — time ONLY its wait (not the trailing query), then confirm the query now serves.
      const w0 = Date.now();
      await subscriber.awaitReady(c, token);
      const awaitReadyMs = Date.now() - w0;
      await c.execute("SELECT 1"); // must succeed once the gate has waited the window out
      return { windowOpen, awaitReadyMs };
    });
    const name = subscriber.idFor(token);
    if (r.result === "served" && r.value) {
      fixServed++;
      if (r.value.windowOpen) {
        fixExercised++;
        fixWaitTotalMs += r.value.awaitReadyMs;
      }
      console.log(
        `  #${String(i + 1).padStart(2)} ${name}  connect@${fmtMs(r.connectAtMs)} window=${r.value.windowOpen ? "OPEN" : "closed"} awaitReady=${r.value.awaitReadyMs}ms → served`,
      );
    } else if (r.result === "SERVE_GAP_404" || r.result === "READINESS_TIMEOUT") {
      fixRegressed++;
      console.log(
        `  #${String(i + 1).padStart(2)} ${name}  REGRESSION: ${
          r.result === "READINESS_TIMEOUT"
            ? "awaitReady exhausted its bounded readiness budget"
            : "query still 404'd AFTER awaitReady"
        }${r.detail ? ` (${r.detail})` : ""}`,
      );
    } else {
      fixInfra++;
      console.log(
        `  #${String(i + 1).padStart(2)} ${name}  infra (${r.result}${r.detail ? `: ${r.detail}` : ""}) — not a fix signal`,
      );
    }
  }

  console.log(
    "\ncleanup: no automatic deletion; review the exact database names above before removing them.",
  );

  // ---- Verdict -------------------------------------------------------------------------------------------
  console.log(
    `\nPhase 1 (no gate):    ${reproduced}/${N} SERVE_GAP_404, served=${servedRaw}, infra=${infra1}`,
  );
  console.log(
    `Phase 2 (awaitReady): served=${fixServed}/${N} (window OPEN in ${fixExercised}, avg awaitReady wait ${
      fixExercised ? Math.round(fixWaitTotalMs / fixExercised) : 0
    }ms), regressed=${fixRegressed}, infra=${fixInfra}`,
  );

  // INCONCLUSIVE: Phase 1 never reached the data plane at all (auth/network/creation) — nothing was tested.
  if (reproduced + servedRaw === 0) {
    console.log(
      "\n⚠️  INCONCLUSIVE: never reached the data plane (auth/network/creation problem, not the 404). Check creds/region.",
    );
    process.exit(2);
  }
  // REGRESSION: the gate ran but readiness still failed — the fix is broken or its bound is inadequate.
  if (fixRegressed > 0) {
    console.log(
      `\n❌ REGRESSION: ${fixRegressed} db(s) remained unready after awaitReady — the fix is broken or its bound is inadequate.`,
    );
    process.exit(1);
  }
  if (fixExercised > 0) {
    console.log(
      `\n✅ awaitReady absorbed ${fixExercised} observed open create→serve window(s) (Phase-1 repro ${reproduced}/${N}, avg wait ${Math.round(fixWaitTotalMs / fixExercised)}ms).`,
    );
    process.exit(0);
  }
  console.log(
    `\n⚠️  INCONCLUSIVE: awaitReady never encountered an open Phase-2 window${
      reproduced > 0 ? ` (Phase 1 reproduced ${reproduced}/${N})` : ""
    }. Re-run with more iterations or a colder region; this is not a passing live gate.`,
  );
  process.exit(2);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});
