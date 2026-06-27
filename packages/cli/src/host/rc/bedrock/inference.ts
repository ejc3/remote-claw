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

/** The subset of `http.ServerResponse` the handler needs (keeps it unit-testable). */
export interface Responder {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array): unknown;
  end(chunk?: string | Uint8Array): unknown;
  readonly writableEnded?: boolean;
}

export interface BedrockConfig {
  /** AWS region for the mantle endpoint (default AWS_REGION / AWS_DEFAULT_REGION / us-east-1). */
  region?: string;
  /** Force a specific Bedrock model id (else map from claude's `model`). */
  modelOverride?: string;
  /** `anthropic-beta` allowlist override. */
  allowedBetas?: ReadonlySet<string>;
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
    if (this.#authPromise === null) {
      this.#authPromise = (this.#cfg.resolveAuth ?? resolveBedrockAuth)();
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
    try {
      const mantlePath =
        path === "/v1/messages/count_tokens"
          ? "/anthropic/v1/messages/count_tokens"
          : "/anthropic/v1/messages";
      const opts = this.#cfg.allowedBetas ? { allowedBetas: this.#cfg.allowedBetas } : {};
      const translated = translateMessagesBody(body.toString("utf8"), {
        ...(this.#cfg.modelOverride !== undefined
          ? { modelOverride: this.#cfg.modelOverride }
          : {}),
        ...opts,
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
      });

      const ct = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(upstream.status, { "content-type": ct, "cache-control": "no-cache" });
      this.#trace.debug("bedrock ←", { status: upstream.status, ct });
      if (upstream.body === null) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !res.writableEnded) res.write(value);
      }
      res.end();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.#trace.warn("bedrock error", { error: msg });
      if (res.writableEnded !== true) {
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
