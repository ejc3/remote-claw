import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { base64urlEncode } from "@remote-claw/clawsec";
import {
  assertRuntimeOwnerRpcPlatform,
  RuntimeOwnerRpcAuthenticator,
  runtimeOwnerRpcSocketAddress,
} from "./auth.js";
import {
  encodeRuntimeOwnerRpcFrame,
  parseRuntimeOwnerRpcAuthenticated,
  parseRuntimeOwnerRpcChallenge,
  parseRuntimeOwnerRpcRequest,
  parseRuntimeOwnerRpcResponse,
  RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
  RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
  RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION,
  RUNTIME_OWNER_RPC_VERSION,
  type RuntimeOwnerRpcDispatchRequest,
  RuntimeOwnerRpcError,
  RuntimeOwnerRpcFrameDecoder,
  type RuntimeOwnerRpcJsonValue,
  type RuntimeOwnerRpcRequest,
} from "./protocol.js";

export interface ConnectRuntimeOwnerRpcOptions {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxInFlight?: number;
}

interface PendingRequest {
  readonly resolve: (value: RuntimeOwnerRpcJsonValue) => void;
  readonly reject: (error: RuntimeOwnerRpcError) => void;
  readonly timer: NodeJS.Timeout;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  return selected;
}

export class RuntimeOwnerRpcClient {
  readonly #socket: Socket;
  readonly #decoder = new RuntimeOwnerRpcFrameDecoder();
  readonly #requestTimeoutMs: number;
  readonly #maxInFlight: number;
  readonly #usedRequestIds = new Set<string>();
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;

  private constructor(socket: Socket, requestTimeoutMs: number, maxInFlight: number) {
    this.#socket = socket;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxInFlight = maxInFlight;
    socket.on("data", (chunk) => {
      if (typeof chunk === "string") {
        this.close();
        return;
      }
      this.#receive(chunk);
    });
    socket.once("error", () => this.#failAll("CLOSED"));
    socket.once("close", () => this.#failAll("CLOSED"));
  }

  static async connect(options: ConnectRuntimeOwnerRpcOptions): Promise<RuntimeOwnerRpcClient> {
    assertRuntimeOwnerRpcPlatform();
    const handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs,
      RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
      60_000,
    );
    const requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
      300_000,
    );
    const maxInFlight = boundedInteger(
      options.maxInFlight,
      RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
      RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
    );
    const authenticator = await RuntimeOwnerRpcAuthenticator.create(
      options.machineIdentityId,
      options.identitySecret,
    );
    try {
      const socket = await authenticateSocket(
        runtimeOwnerRpcSocketAddress(options.machineIdentityId),
        authenticator,
        handshakeTimeoutMs,
      );
      return new RuntimeOwnerRpcClient(socket, requestTimeoutMs, maxInFlight);
    } finally {
      authenticator.close();
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  health(): Promise<RuntimeOwnerRpcJsonValue> {
    return this.#send("health", null);
  }

  dispatch(request: RuntimeOwnerRpcDispatchRequest): Promise<RuntimeOwnerRpcJsonValue> {
    return this.#send("dispatch", request);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#failAll("CLOSED");
  }

  #send(
    method: RuntimeOwnerRpcRequest["method"],
    params: RuntimeOwnerRpcDispatchRequest | null,
  ): Promise<RuntimeOwnerRpcJsonValue> {
    if (this.#closed || this.#socket.destroyed) {
      return Promise.reject(new RuntimeOwnerRpcError("CLOSED"));
    }
    if (this.#pending.size >= this.#maxInFlight) {
      return Promise.reject(new RuntimeOwnerRpcError("TOO_MANY_IN_FLIGHT"));
    }
    if (this.#usedRequestIds.size >= RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION) {
      this.close();
      return Promise.reject(new RuntimeOwnerRpcError("CLOSED"));
    }
    let requestId: string;
    try {
      requestId = this.#allocateRequestId();
    } catch (error) {
      return Promise.reject(
        error instanceof RuntimeOwnerRpcError ? error : new RuntimeOwnerRpcError("UNAVAILABLE"),
      );
    }
    const candidate = {
      version: RUNTIME_OWNER_RPC_VERSION,
      type: "request",
      requestId,
      method,
      params,
    };
    let request: RuntimeOwnerRpcRequest;
    try {
      request = parseRuntimeOwnerRpcRequest(candidate);
    } catch (error) {
      return Promise.reject(
        error instanceof RuntimeOwnerRpcError ? error : new RuntimeOwnerRpcError("PROTOCOL_ERROR"),
      );
    }
    return new Promise<RuntimeOwnerRpcJsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(requestId)) return;
        this.#pending.delete(requestId);
        reject(new RuntimeOwnerRpcError("TIMEOUT"));
        // A late response cannot be safely associated with any retry on this channel.
        this.close();
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        this.#socket.write(encodeRuntimeOwnerRpcFrame(request));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(new RuntimeOwnerRpcError("CLOSED"));
        this.close();
      }
    });
  }

  #allocateRequestId(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = base64urlEncode(randomBytes(16));
      if (!this.#usedRequestIds.has(candidate)) {
        this.#usedRequestIds.add(candidate);
        return candidate;
      }
    }
    this.close();
    throw new RuntimeOwnerRpcError("UNAVAILABLE");
  }

  #receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    try {
      for (const value of this.#decoder.push(chunk)) {
        const response = parseRuntimeOwnerRpcResponse(value);
        const pending = this.#pending.get(response.requestId);
        if (pending === undefined) throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
        this.#pending.delete(response.requestId);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new RuntimeOwnerRpcError(response.error.code));
      }
    } catch {
      this.close();
    }
  }

  #failAll(code: "CLOSED"): void {
    if (!this.#closed) this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeOwnerRpcError(code));
    }
    this.#pending.clear();
  }
}

async function authenticateSocket(
  address: string,
  authenticator: RuntimeOwnerRpcAuthenticator,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: address });
    const decoder = new RuntimeOwnerRpcFrameDecoder();
    let challenge: string | undefined;
    let settled = false;
    const finish = (error?: RuntimeOwnerRpcError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error !== undefined) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onData = (chunk: string | Uint8Array): void => {
      try {
        if (typeof chunk === "string") throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
        const values = decoder.push(chunk);
        for (const value of values) {
          if (challenge === undefined) {
            const serverChallenge = parseRuntimeOwnerRpcChallenge(value);
            if (
              !authenticator.verifyServerProof(
                serverChallenge.challenge,
                serverChallenge.serverProof,
              )
            ) {
              throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
            }
            challenge = serverChallenge.challenge;
            socket.write(
              encodeRuntimeOwnerRpcFrame({
                version: RUNTIME_OWNER_RPC_VERSION,
                type: "authenticate",
                challenge,
                clientProof: authenticator.createClientProof(challenge),
              }),
            );
            continue;
          }
          const authenticated = parseRuntimeOwnerRpcAuthenticated(value);
          if (authenticated.challenge !== challenge) {
            throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
          }
          if (values.length !== 1) throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
          finish();
        }
      } catch (error) {
        finish(
          error instanceof RuntimeOwnerRpcError
            ? error
            : new RuntimeOwnerRpcError("AUTHENTICATION_FAILED"),
        );
      }
    };
    const onError = (): void => finish(new RuntimeOwnerRpcError("UNAVAILABLE"));
    const onClose = (): void =>
      finish(
        new RuntimeOwnerRpcError(challenge === undefined ? "UNAVAILABLE" : "AUTHENTICATION_FAILED"),
      );
    const timer = setTimeout(() => finish(new RuntimeOwnerRpcError("TIMEOUT")), timeoutMs);
    timer.unref();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function connectRuntimeOwnerRpc(
  options: ConnectRuntimeOwnerRpcOptions,
): Promise<RuntimeOwnerRpcClient> {
  return RuntimeOwnerRpcClient.connect(options);
}
