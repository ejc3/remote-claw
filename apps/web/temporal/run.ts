import { fileURLToPath } from "node:url";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { temporalConfig } from "./connection";

// Shared bootstrap for the relayChannel worker, used by BOTH callers so they can't drift:
//   • temporal/worker.ts          — the standalone worker SERVICE (runs forever; dev + self-hosted).
//   • app/api/temporal/drain      — the Vercel keep-warm route (runs a BOUNDED window, re-armed by a
//                                   cron) because a serverless function can't poll a queue 24/7.
//
// The workflow code is bundled ONCE per process and cached. bundleWorkflowCode runs the Temporal
// workflow bundler (webpack/swc) over workflows.ts — multi-second work — so on Vercel the every-
// minute cron keeps the function instance warm and only the first drain pays the bundling cost.

let cachedBundle: Promise<WorkflowBundleWithSourceMap> | undefined;

/** The relayChannel workflow code, bundled for the worker. Cached process-wide (see above). Exposed
 *  so the drain route's `?selftest=1` can prove the bundler runs in-function without a cluster. */
export function relayWorkflowBundle(): Promise<WorkflowBundleWithSourceMap> {
  if (cachedBundle === undefined) {
    cachedBundle = bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    });
  }
  return cachedBundle;
}

export interface RelayWorker {
  worker: Worker;
  connection: NativeConnection;
  namespace: string;
  taskQueue: string;
  address: string;
}

/** Connect + build a relayChannel Worker (not yet running). Caller drives worker.run()/shutdown(). */
export async function createRelayWorker(): Promise<RelayWorker> {
  const { namespace, taskQueue, connection: opts } = temporalConfig();
  const connection = await NativeConnection.connect(opts);
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowBundle: await relayWorkflowBundle(),
    });
    return { worker, connection, namespace, taskQueue, address: opts.address };
  } catch (e) {
    // Don't leak the gRPC connection if Worker.create fails (bad bundle, auth, unreachable cluster).
    await connection.close().catch(() => {});
    throw e;
  }
}

export interface DrainResult {
  ran: true;
  windowMs: number;
  namespace: string;
  taskQueue: string;
  address: string;
}

/** Run the relayChannel worker for ~windowMs, then drain in-flight tasks and close. Resolves once the
 *  worker has fully shut down. The window is sized UNDER the function's maxDuration and OVER the cron
 *  interval so successive invocations overlap (there's never a moment with no poller). worker.run()
 *  resolves after shutdown()'s graceful drain completes. */
export async function runRelayWorkerFor(windowMs: number): Promise<DrainResult> {
  const { worker, connection, namespace, taskQueue, address } = await createRelayWorker();
  const timer = setTimeout(() => {
    worker.shutdown();
  }, windowMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    await worker.run(); // resolves when the timer-triggered shutdown's graceful drain finishes
  } finally {
    clearTimeout(timer);
    await connection.close().catch(() => {});
  }
  return { ran: true, windowMs, namespace, taskQueue, address };
}
