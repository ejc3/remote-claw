import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { temporalConfig } from "./connection";

// Hosts the relayChannel workflow on a task queue — a long-running SERVICE, run both in dev
// (`temporal server start-dev`) and in production (against Temporal Cloud / a self-hosted cluster)
// whenever BROKER_BACKEND=temporal. The Next server's TemporalBackend signals/queries these
// workflows. No activities — the workflow is pure in-memory state driven by signals + a query.
// Connection settings (address, namespace, TLS / Cloud API key) come from temporalConfig().
// Dev: `pnpm --filter @remote-claw/web temporal:worker`.

async function main(): Promise<void> {
  const { namespace, taskQueue, connection: opts } = temporalConfig();
  const connection = await NativeConnection.connect(opts);
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  });
  // Drain in-flight tasks on a rolling restart instead of being hard-killed (Worker.run() resolves
  // once shutdown completes).
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      worker.shutdown();
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[temporal-worker] ready — ${opts.address} ns=${namespace} queue=${taskQueue}`);
  await worker.run();
  await connection.close();
}

main().catch((e) => {
  console.error("[temporal-worker] fatal:", e);
  process.exit(1);
});
