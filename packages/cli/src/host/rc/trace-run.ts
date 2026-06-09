// `remote-claw --rc-trace` — a live protocol inspector. It stands up the SAME MITM harness as the
// wrapper (HTTPS_PROXY + NODE_EXTRA_CA_CERTS), but in "trace" mode: instead of serving the RC worker
// endpoints from our RelayCore and bridging to the broker, it passes EVERYTHING through to the real
// api.anthropic.com and TRACES the RC traffic both ways. Nothing touches the broker — it's just you,
// real claude, and the real API, with the worker protocol narrated on stderr (or RC_LOG_FILE).
//
// Drive it from the CLI (it spawns `claude` behind the proxy), or from the native app: run it, then
// point the app's HTTPS proxy at the printed loopback port and trust the printed CA. Set
// `RC_LOG=debug` for frame shapes or `RC_LOG=trace` for full bodies (RC_LOG_FILE=… to capture).

import { tracerFromEnv } from "../../trace.js";
import { ensureCerts } from "./certs.js";
import type { SpawnClaudeEnv } from "./launch.js";
import { MitmProxy } from "./mitm.js";

export interface RcTraceOptions {
  /** Args forwarded verbatim to claude (when spawning the CLI). */
  claudeArgs: string[];
  /** Directory holding the MITM CA + leaf (generated if absent). */
  certsDir: string;
  /** The claude binary (default "claude"). */
  claudeBin?: string;
  /** Launch the child behind the proxy env. If omitted, the proxy just runs until `signal` aborts
   *  (point a native app at it). */
  spawnClaude?: SpawnClaudeEnv;
  /** Abort to tear the proxy down when not spawning a child (native-app mode). */
  signal?: AbortSignal;
  /** Human notice sink (proxy URL + CA path + how-to). Defaults to process.stderr. */
  note?: (s: string) => void;
}

/**
 * Stand up the tracing MITM → real Anthropic and (optionally) spawn claude behind it. Resolves with
 * claude's exit code when spawning, else stays up until `signal` aborts (resolving 0). Always tears
 * the proxy down.
 */
export async function runRcTrace(opts: RcTraceOptions): Promise<number> {
  const certs = ensureCerts(opts.certsDir);
  const proxy = new MitmProxy({
    port: 0,
    leafCert: certs.leafPem,
    leafKey: certs.leafKey,
    mode: "trace",
    tracer: tracerFromEnv("rc.mitm"),
  });
  await proxy.listen();

  const note = opts.note ?? ((s: string) => void process.stderr.write(s));
  note(`remote-claw trace MITM → real api.anthropic.com\n`);
  note(`  proxy: http://127.0.0.1:${proxy.port}\n`);
  note(`  CA:    ${certs.caPem}\n`);
  note(
    `  RC traffic is traced both ways. Set RC_LOG=debug (shapes) or RC_LOG=trace (full bodies).\n`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    https_proxy: `http://127.0.0.1:${proxy.port}`,
    NODE_EXTRA_CA_CERTS: certs.caPem,
  };
  // A pre-existing NO_PROXY could make the child BYPASS our MITM despite HTTPS_PROXY — clear it.
  delete env.NO_PROXY;
  delete env.no_proxy;

  try {
    if (opts.spawnClaude) {
      return await opts.spawnClaude(opts.claudeBin ?? "claude", opts.claudeArgs, env);
    }
    // Native-app mode: keep the proxy up until aborted.
    note(
      `  no child spawned — point your app's HTTPS proxy at the port above, then Ctrl-C to stop.\n`,
    );
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return 0;
  } finally {
    await proxy.close();
  }
}
