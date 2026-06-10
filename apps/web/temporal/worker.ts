import { createRelayWorker } from "./run";

// Hosts the relayChannel workflow on a task queue — a long-running SERVICE, run in dev
// (`temporal server start-dev`) and in production wherever you want a dedicated always-on worker
// (a VM / Fly / Render). On Vercel there is NO standalone worker: app/api/temporal/drain + a cron
// keep a BOUNDED worker warm instead. Both paths share createRelayWorker() in ./run so they can't
// drift. No activities — the workflow is pure in-memory state driven by signals + a query.
// Dev: `pnpm --filter @remote-claw/web temporal:worker`.

async function main(): Promise<void> {
  const { worker, connection, namespace, taskQueue, address } = await createRelayWorker();
  // Drain in-flight tasks on a rolling restart instead of being hard-killed (Worker.run() resolves
  // once shutdown completes).
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      worker.shutdown();
    });
  }
  // eslint-disable-next-line no-console
  console.log(`[temporal-worker] ready — ${address} ns=${namespace} queue=${taskQueue}`);
  await worker.run();
  await connection.close();
}

main().catch((e) => {
  console.error("[temporal-worker] fatal:", e);
  process.exit(1);
});
