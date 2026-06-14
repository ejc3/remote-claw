// Standalone harness that REPRODUCES the Turso Cloud "create→serve" 404 race and VERIFIES the awaitReady
// fix — deterministically, with no cloud account.
//
// Run:  pnpm --filter @remote-claw/web exec tsx scripts/verify-turso-404.ts
//
// The bug (seen live on a Vercel preview, default backend = per-session Turso Cloud): the Platform-API
// `POST /databases` returns 200 BEFORE the new db's libSQL endpoint is serving, so the first query to it
// throws `LibsqlError: SERVER_ERROR: Server returned HTTP status 404` (cause HttpServerError status 404).
// It hit publish, subscribe, AND frame-count for a fresh session in the same window.
//
// This harness models that window faithfully against a REAL file-backed libSQL via the SAME
// SqliteMultiBackend the broker ships: a wrapping client factory throws the EXACT production error shape
// for every query for PROPAGATION_MS after a client to a "freshly-created" db is opened. We then run
// publish / subscribe / frame-count from a FRESH instance (fresh client cache → a new client opened
// inside the window) in two configs:
//   • WITHOUT the gate (plain FileDbLocator)           → all three 404  (the production fingerprint)
//   • WITH the gate    (delegates to the SHIPPED         → all three succeed (the fix absorbs the window)
//                       TursoCloudDbLocator.awaitReady)
// The "with fix" path runs the ACTUAL shipped awaitReady — it operates purely on the passed client, so a
// dummy-cred TursoCloudDbLocator (its fetch is never called) exercises the real retry/backoff/predicate.
//
// Faithfulness notes (adversarially audited): the window is modelled by TIME (not a query count), so
// awaitReady must genuinely wait out the real duration — it can't "use up" a budget of probes and then let
// the real query pass artificially. The without-gate 404 must surface BEFORE the subscribe stream is
// created (it does — in acquire), because SERVER_ERROR is in the subscribe poll loop's transient-retry set
// and would otherwise be masked. In file mode the first query to 404 is the WAL PRAGMA (the cloud locator
// has no prepare() → its first query is the schema batch); the awaitReady gate runs before BOTH, so the
// demonstration is identical either way.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, type Config, createClient } from "@libsql/client";
import type { WireFrame } from "@remote-claw/clawsec";
import {
  type ClientFactory,
  type DbLocator,
  FileDbLocator,
  SqliteMultiBackend,
} from "../lib/broker/sqlite-multi";
import { TursoCloudDbLocator } from "../lib/broker/turso-cloud-locator";

const PROPAGATION_MS = 600; // how long a brand-new db's endpoint "404s" after a client to it is opened
const TOKEN = `sess:${"0".repeat(32)}:cse_verify404`;
const OPS = ["publish", "subscribe", "frameCount"] as const;
type Op = (typeof OPS)[number];

/** The EXACT @libsql/client error a not-yet-serving endpoint produces: LibsqlError(code SERVER_ERROR)
 *  wrapping HttpServerError(status 404). */
function notReady404(): Error {
  return Object.assign(new Error("SERVER_ERROR: Server returned HTTP status 404"), {
    code: "SERVER_ERROR",
    cause: Object.assign(new Error("Server returned HTTP status 404"), { status: 404 }),
  });
}

/** A ClientFactory over real file clients. Once `arm()` is called, every NEW client simulates the
 *  create→serve window: it throws notReady404() for every query until PROPAGATION_MS after it was opened,
 *  then passes through to the real client. (Models a fresh instance connecting to a just-created db.) */
function make404Factory(): { factory: ClientFactory; arm: () => void } {
  let armed = false;
  const factory = ((config: Config): Client => {
    const real = createClient(config);
    const readyAt = armed ? Date.now() + PROPAGATION_MS : 0;
    const notYet = () => Date.now() < readyAt;
    const guard =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      (...a: A): Promise<R> => {
        if (notYet()) return Promise.reject(notReady404());
        return fn(...a);
      };
    return new Proxy(real, {
      get(t, p) {
        if (p === "execute") return guard(t.execute.bind(t));
        if (p === "batch") return guard(t.batch.bind(t));
        if (p === "transaction") return guard(t.transaction.bind(t));
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as Client;
  }) as ClientFactory;
  return { factory, arm: () => (armed = true) };
}

/** FileDbLocator + the SHIPPED awaitReady (delegated to a dummy-cred cloud locator — awaitReady only uses
 *  the passed client, never the Platform API), i.e. exactly what the cloud backend runs in production. */
class FileLocatorWithReady extends FileDbLocator {
  readonly #cloud = new TursoCloudDbLocator({
    apiToken: "unused",
    org: "unused",
    group: "unused",
    authToken: "unused",
    scope: "dev",
    fetchImpl: (() =>
      Promise.reject(
        new Error("Platform API must not be called by awaitReady"),
      )) as unknown as typeof fetch,
  });
  awaitReady(client: Client, token: string): Promise<void> {
    return this.#cloud.awaitReady(client, token);
  }
}

function frame(seq: number): WireFrame {
  return { seq } as unknown as WireFrame;
}

async function takeOne(stream: ReadableStream<WireFrame>): Promise<WireFrame | null> {
  const reader = stream.getReader();
  try {
    const { value, done } = await reader.read();
    return done ? null : (value ?? null);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Run one operation from a FRESH backend (fresh client cache ⇒ a new client opened inside the window). */
async function runOp(
  op: Op,
  dir: string,
  factory: ClientFactory,
  useGate: boolean,
): Promise<string> {
  const locator: DbLocator = useGate ? new FileLocatorWithReady(dir) : new FileDbLocator(dir);
  const be = new SqliteMultiBackend(locator, factory);
  const startedAt = Date.now();
  try {
    if (op === "publish") await be.publish(TOKEN, frame(4));
    else if (op === "subscribe") {
      const s = await be.subscribe(TOKEN, undefined);
      if (s === null) throw new Error("subscribe returned null (channel missing)");
      await takeOne(s);
    } else {
      const n = await be.frameCount(TOKEN);
      if (typeof n !== "number") throw new Error(`frameCount returned ${n}`);
    }
    return `ok (${Date.now() - startedAt}ms)`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `FAIL: ${msg}`;
  }
}

async function exercise(useGate: boolean): Promise<Record<Op, string>> {
  const dir = mkdtempSync(join(tmpdir(), "rc-verify404-"));
  try {
    const { factory, arm } = make404Factory();
    // Phase 1 — the "host" creates the db + publishes a turn while its endpoint is already serving.
    const host = new SqliteMultiBackend(new FileDbLocator(dir), factory);
    for (let seq = 1; seq <= 3; seq++) await host.publish(TOKEN, frame(seq));
    // Phase 2 — every NEW client now hits the create→serve window. Each op opens a fresh client.
    arm();
    const results = {} as Record<Op, string>;
    for (const op of OPS) results[op] = await runOp(op, dir, factory, useGate);
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ok(line: string): boolean {
  return line.startsWith("ok");
}

async function main(): Promise<void> {
  console.log("=== Turso Cloud create→serve 404 race — reproduction + fix verification ===");
  console.log(
    `propagation window: ${PROPAGATION_MS}ms (a fresh db's endpoint 404s for this long after open)\n`,
  );

  const without = await exercise(false);
  console.log("[WITHOUT awaitReady gate]  (reproduces the production bug)");
  for (const op of OPS) console.log(`  ${op.padEnd(11)} → ${without[op]}`);
  const reproduced = OPS.every((op) => without[op].includes("404"));
  console.log(
    `  ⇒ ${OPS.filter((op) => !ok(without[op])).length}/3 operations 404'd during the window` +
      `  ${reproduced ? "✗ (bug reproduced)" : "?? (did NOT reproduce — harness suspect)"}\n`,
  );

  const withGate = await exercise(true);
  console.log(
    "[WITH awaitReady gate]  (the fix — delegates to the SHIPPED TursoCloudDbLocator.awaitReady)",
  );
  for (const op of OPS) console.log(`  ${op.padEnd(11)} → ${withGate[op]}`);
  const fixed = OPS.every((op) => ok(withGate[op]));
  console.log(
    `  ⇒ ${OPS.filter((op) => ok(withGate[op])).length}/3 operations succeeded (each waited out the window)` +
      `  ${fixed ? "✓ (fix verified)" : "✗ (fix did NOT hold)"}\n`,
  );

  const pass = reproduced && fixed;
  console.log(
    `VERDICT: ${pass ? "✓ bug reproduced WITHOUT the gate AND fixed WITH it" : "✗ verification did not hold — see above"}`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});
