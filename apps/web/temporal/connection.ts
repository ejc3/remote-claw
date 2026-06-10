import { readFileSync } from "node:fs";
import { DEFAULT_ADDRESS, DEFAULT_NAMESPACE, DEFAULT_TASK_QUEUE } from "./names";

// Resolve Temporal connection settings from the environment, shared by the TemporalBackend (the Next
// server's @temporalio/client Connection) and the worker (@temporalio/worker NativeConnection). The
// `connection` object is accepted by both SDKs. Covers local dev (plaintext localhost) AND production
// (Temporal Cloud via API key or mTLS, or any TLS-fronted self-hosted server):
//
//   TEMPORAL_ADDRESS        host:port (default 127.0.0.1:7233; Cloud: <ns>.<acct>.tmprl.cloud:7233)
//   TEMPORAL_NAMESPACE      default "default" (Cloud: <ns>.<acct>)
//   TEMPORAL_TASK_QUEUE     default "relay"
//   TEMPORAL_API_KEY        Temporal Cloud API-key auth (implies TLS)
//   TEMPORAL_TLS            "1"/"true" → enable server TLS (no client cert)
//   TEMPORAL_TLS_CERT_PATH  + TEMPORAL_TLS_KEY_PATH → mTLS client certificate pair (implies TLS)

type Tls = boolean | { clientCertPair: { crt: Buffer; key: Buffer } };

export interface TemporalConnectionOptions {
  address: string;
  tls?: Tls;
  apiKey?: string;
}

export interface TemporalConfig {
  namespace: string;
  taskQueue: string;
  connection: TemporalConnectionOptions;
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

export function temporalConfig(): TemporalConfig {
  const address = process.env.TEMPORAL_ADDRESS ?? DEFAULT_ADDRESS;
  const namespace = process.env.TEMPORAL_NAMESPACE ?? DEFAULT_NAMESPACE;
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;
  const apiKey = process.env.TEMPORAL_API_KEY;
  const certPath = process.env.TEMPORAL_TLS_CERT_PATH;
  const keyPath = process.env.TEMPORAL_TLS_KEY_PATH;

  let tls: Tls | undefined;
  if (certPath && keyPath) {
    tls = { clientCertPair: { crt: readFileSync(certPath), key: readFileSync(keyPath) } };
  } else if (apiKey || truthy(process.env.TEMPORAL_TLS)) {
    tls = true; // server TLS; API-key auth needs it
  }

  const connection: TemporalConnectionOptions = { address };
  if (tls !== undefined) connection.tls = tls;
  if (apiKey) connection.apiKey = apiKey;
  return { namespace, taskQueue, connection };
}

/** Query-poll interval for subscribe() (ms). Tunable for prod load vs latency. */
export function temporalPollMs(): number {
  const n = Number.parseInt(process.env.TEMPORAL_POLL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 150;
}
