// The Bedrock inference handler: serves claude's `/v1/messages*` from the native `bedrock-mantle`
// endpoint. Translates the body (model rewrite + scrub), signs (SigV4) or bearer-authenticates, calls
// Bedrock, and streams the SSE (which is already the exact Anthropic wire format) straight back to the
// child claude. The MITM's `#passthrough` delegates here when `inference==="bedrock"`. Auth is
// resolved once and cached. Errors are forwarded verbatim (mantle returns Anthropic-format error JSON)
// so claude surfaces a real message (e.g. a permission_error) rather than a dead stream.

import { NOOP_TRACER, type Tracer } from "../../../trace.js";
import { type BedrockAuth, bedrockRegion, resolveBedrockAuth } from "./creds.js";
import { signRequest } from "./sigv4.js";
import { filterBetaHeader, translateMessagesBody } from "./translate.js";

/** The subset of `http.ServerResponse` the handler needs (keeps it unit-testable). `write` returns the
 *  node backpressure signal (false ⇒ buffer full) and invokes its callback once the chunk is flushed —
 *  OR when the stream errors/closes — which we await for backpressure without leaking event listeners. */
export interface Responder {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(chunk?: string | Uint8Array): unknown;
  /** Subscribe to `close` so we can abort the Bedrock call when the child disconnects. */
  on?(event: "close", listener: () => void): unknown;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
}

export interface BedrockConfig {
  /** AWS region for the mantle endpoint (default AWS_REGION / AWS_DEFAULT_REGION / us-east-1). */
  region?: string;
  /** Force a specific Bedrock model id (else map from claude's `model`). */
  modelOverride?: string;
  /** `anthropic-beta` allowlist override. */
  allowedBetas?: ReadonlySet<string>;
  /** Extra body keys to strip (on top of the built-in set) — e.g. from RC_BEDROCK_STRIP_KEYS. */
  stripKeys?: ReadonlySet<string>;
  /** Injected fetch (tests). */
  fetchFn?: typeof fetch;
  /** Injected auth resolver (tests). */
  resolveAuth?: () => Promise<BedrockAuth>;
  tracer?: Tracer;
}

const ANTHROPIC_VERSION = "2023-06-01";
const MANTLE_SERVICE = "bedrock-mantle";

export class BedrockInference {
  readonly #cfg: BedrockConfig;
  readonly #region: string;
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #trace: Tracer;
  #authPromise: Promise<BedrockAuth> | null = null;
  #cachedAuth: BedrockAuth | null = null;
  /** Epoch ms when the cached (temporary) credentials expire; 0 ⇒ non-expiring (bearer / static env). */
  #authExpiresAt = 0;

  constructor(cfg: BedrockConfig = {}) {
    this.#cfg = cfg;
    this.#region = bedrockRegion(cfg.region);
    this.#host = `bedrock-mantle.${this.#region}.api.aws`;
    this.#fetch = cfg.fetchFn ?? fetch;
    this.#trace = cfg.tracer ?? NOOP_TRACER;
  }

  /** The mantle endpoint host (for diagnostics). */
  get host(): string {
    return this.#host;
  }

  #auth(): Promise<BedrockAuth> {
    // Reuse cached auth until it's within 60s of expiry (instance-role creds rotate ~hourly). A
    // non-expiring auth (bearer / static env) has expiresAt 0 and is reused forever.
    if (
      this.#cachedAuth !== null &&
      (this.#authExpiresAt === 0 || Date.now() < this.#authExpiresAt - 60_000)
    ) {
      return Promise.resolve(this.#cachedAuth);
    }
    if (this.#authPromise === null) {
      const p = (this.#cfg.resolveAuth ?? resolveBedrockAuth)();
      this.#authPromise = p;
      p.then((a) => {
        this.#cachedAuth = a;
        this.#authExpiresAt =
          a.kind === "sigv4" && a.credentials.expiration !== undefined
            ? a.credentials.expiration
            : 0;
      })
        // Drop a REJECTED promise so a transient creds/IMDS failure retries on the next request instead
        // of poisoning the session; the `finally` also clears it after success so expiry can re-resolve.
        .catch(() => undefined)
        .finally(() => {
          if (this.#authPromise === p) this.#authPromise = null;
        });
    }
    return this.#authPromise;
  }

  /** Serve one `/v1/messages` or `/v1/messages/count_tokens` request from Bedrock. `path` is the
   *  incoming api.anthropic.com path; `reqHeaders` are claude's request headers (for anthropic-beta). */
  async serve(
    path: string,
    reqHeaders: Record<string, string | undefined>,
    body: Buffer,
    res: Responder,
  ): Promise<void> {
    let headWritten = false;
    // Abort the Bedrock call when the child claude disconnects. A remote abort closes/destroys the
    // response WITHOUT setting `writableEnded` (mirrors mitm.ts #streamWorker), so watch `close` — else
    // Bedrock keeps generating (and billing) a response nobody is reading.
    const ac = new AbortController();
    if (typeof res.on === "function") res.on("close", () => ac.abort());
    try {
      const mantlePath =
        path === "/v1/messages/count_tokens"
          ? "/anthropic/v1/messages/count_tokens"
          : "/anthropic/v1/messages";
      const translated = translateMessagesBody(body.toString("utf8"), {
        ...(this.#cfg.modelOverride !== undefined
          ? { modelOverride: this.#cfg.modelOverride }
          : {}),
        ...(this.#cfg.allowedBetas ? { allowedBetas: this.#cfg.allowedBetas } : {}),
        ...(this.#cfg.stripKeys ? { extraStripKeys: this.#cfg.stripKeys } : {}),
      });

      const sendHeaders: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
      };
      const beta = filterBetaHeader(
        headerValue(reqHeaders, "anthropic-beta"),
        this.#cfg.allowedBetas,
      );
      if (beta !== "") sendHeaders["anthropic-beta"] = beta;

      const auth = await this.#auth();
      let finalHeaders: Record<string, string>;
      if (auth.kind === "bearer") {
        finalHeaders = { ...sendHeaders, authorization: `Bearer ${auth.token}` };
      } else {
        finalHeaders = signRequest({
          method: "POST",
          host: this.#host,
          path: mantlePath,
          region: this.#region,
          service: MANTLE_SERVICE,
          body: translated.body,
          headers: sendHeaders,
          credentials: auth.credentials,
        });
      }

      this.#trace.debug("bedrock →", {
        path: mantlePath,
        model: translated.model,
        auth: auth.kind,
      });
      const upstream = await this.#fetch(`https://${this.#host}${mantlePath}`, {
        method: "POST",
        headers: finalHeaders,
        body: translated.body,
        signal: ac.signal,
      });

      const ct = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(upstream.status, { "content-type": ct, "cache-control": "no-cache" });
      headWritten = true;
      this.#trace.debug("bedrock ←", { status: upstream.status, ct });
      if (upstream.body === null) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // client (child claude) went away mid-stream — `destroyed` catches a remote abort that
          // `writableEnded` (only set when WE end) does not.
          if (res.writableEnded === true || res.destroyed === true) break;
          if (value) {
            // Respect backpressure: if the child's socket buffer is full, wait for the chunk to flush
            // before pulling more from Bedrock — else a slow consumer makes us buffer the stream
            // unbounded. The write callback fires on flush OR on close/error, so a disconnect mid-write
            // never hangs us (and there are no lingering event listeners to leak).
            await new Promise<void>((resolve) => {
              if (res.write(value, () => resolve()) !== false) resolve();
            });
          }
        }
      } finally {
        // Release the Bedrock socket on ANY exit (client gone, upstream error, normal end).
        await reader.cancel().catch(() => undefined);
      }
      res.end();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.#trace.warn("bedrock error", { error: msg });
      if (res.writableEnded === true) return;
      if (headWritten) {
        // Headers (and maybe SSE bytes) already went out — can't send a fresh 502 without
        // ERR_HTTP_HEADERS_SENT / corrupting the stream; just close it.
        res.end();
      } else {
        // Anthropic-format error so claude renders a real message instead of a dead stream.
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `bedrock: ${msg}` },
          }),
        );
      }
    }
  }
}

/** Case-insensitive header read from a raw header bag. */
function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
