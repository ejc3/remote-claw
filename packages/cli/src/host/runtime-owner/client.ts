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
  parseRuntimeOwnerInvokePortResult,
  parseRuntimeOwnerRpcAuthenticated,
  parseRuntimeOwnerRpcCallablePortRef,
  parseRuntimeOwnerRpcChallenge,
  parseRuntimeOwnerRpcPortRequest,
  parseRuntimeOwnerRpcRequest,
  parseRuntimeOwnerRpcResponse,
  RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
  RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
  RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION,
  RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION,
  RUNTIME_OWNER_RPC_MAX_REVERSE_IN_FLIGHT,
  RUNTIME_OWNER_RPC_MAX_REVERSE_REQUESTS_PER_CONNECTION,
  RUNTIME_OWNER_RPC_VERSION,
  type RuntimeOwnerRpcCallablePortRef,
  type RuntimeOwnerRpcDispatchRequest,
  RuntimeOwnerRpcError,
  RuntimeOwnerRpcFrameDecoder,
  type RuntimeOwnerRpcJsonValue,
  type RuntimeOwnerRpcPortInvocation,
  type RuntimeOwnerRpcPortResult,
  type RuntimeOwnerRpcRequest,
  runtimeOwnerRpcMessageType,
  runtimeOwnerRpcPortErrorResponse,
  runtimeOwnerRpcPortSuccessResponse,
} from "./protocol.js";

export interface ConnectRuntimeOwnerRpcOptions {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxInFlight?: number;
  readonly maxCallablePorts?: number;
  readonly maxReverseInFlight?: number;
  readonly maxReverseRequestsPerConnection?: number;
}

interface PendingRequest {
  readonly resolve: (value: RuntimeOwnerRpcJsonValue) => void;
  readonly reject: (error: RuntimeOwnerRpcError) => void;
  readonly timer: NodeJS.Timeout;
}

export interface RuntimeOwnerCallablePortHandlerContext {
  readonly signal: AbortSignal;
}

export type RuntimeOwnerCallablePortHandler = (
  invocation: RuntimeOwnerRpcPortInvocation,
  context: RuntimeOwnerCallablePortHandlerContext,
) => Promise<RuntimeOwnerRpcPortResult> | RuntimeOwnerRpcPortResult;

interface ActivePortRequest {
  readonly abortController: AbortController;
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
  readonly #maxCallablePorts: number;
  readonly #maxReverseInFlight: number;
  readonly #maxReverseRequestsPerConnection: number;
  readonly #usedRequestIds = new Set<string>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #callablePortHandlers = new Map<string, RuntimeOwnerCallablePortHandler>();
  readonly #seenReverseRequestIds = new Set<string>();
  readonly #activePortRequests = new Map<string, ActivePortRequest>();
  #closed = false;

  private constructor(
    socket: Socket,
    requestTimeoutMs: number,
    maxInFlight: number,
    maxCallablePorts: number,
    maxReverseInFlight: number,
    maxReverseRequestsPerConnection: number,
  ) {
    this.#socket = socket;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxInFlight = maxInFlight;
    this.#maxCallablePorts = maxCallablePorts;
    this.#maxReverseInFlight = maxReverseInFlight;
    this.#maxReverseRequestsPerConnection = maxReverseRequestsPerConnection;
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
    const maxCallablePorts = boundedInteger(
      options.maxCallablePorts,
      RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION,
      RUNTIME_OWNER_RPC_MAX_PORTS_PER_CONNECTION,
    );
    const maxReverseInFlight = boundedInteger(
      options.maxReverseInFlight,
      RUNTIME_OWNER_RPC_MAX_REVERSE_IN_FLIGHT,
      RUNTIME_OWNER_RPC_MAX_REVERSE_IN_FLIGHT,
    );
    const maxReverseRequestsPerConnection = boundedInteger(
      options.maxReverseRequestsPerConnection,
      RUNTIME_OWNER_RPC_MAX_REVERSE_REQUESTS_PER_CONNECTION,
      RUNTIME_OWNER_RPC_MAX_REVERSE_REQUESTS_PER_CONNECTION,
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
      return new RuntimeOwnerRpcClient(
        socket,
        requestTimeoutMs,
        maxInFlight,
        maxCallablePorts,
        maxReverseInFlight,
        maxReverseRequestsPerConnection,
      );
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

  registerCallablePort(
    callablePortRef: RuntimeOwnerRpcCallablePortRef,
    handler: RuntimeOwnerCallablePortHandler,
  ): void {
    if (this.#closed || this.#socket.destroyed) throw new RuntimeOwnerRpcError("CLOSED");
    const parsed = parseRuntimeOwnerRpcCallablePortRef(callablePortRef);
    if (typeof handler !== "function") {
      throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
    }
    if (this.#callablePortHandlers.has(parsed.protectedHandleId)) {
      throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
    }
    if (this.#callablePortHandlers.size >= this.#maxCallablePorts) {
      throw new RuntimeOwnerRpcError("TOO_MANY_IN_FLIGHT");
    }
    this.#callablePortHandlers.set(parsed.protectedHandleId, handler);
  }

  unregisterCallablePort(callablePortRef: RuntimeOwnerRpcCallablePortRef): boolean {
    const parsed = parseRuntimeOwnerRpcCallablePortRef(callablePortRef);
    return this.#callablePortHandlers.delete(parsed.protectedHandleId);
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
        if (runtimeOwnerRpcMessageType(value) === "port_request") {
          this.#portRequest(parseRuntimeOwnerRpcPortRequest(value));
        } else {
          const response = parseRuntimeOwnerRpcResponse(value);
          const pending = this.#pending.get(response.requestId);
          if (pending === undefined) throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
          this.#pending.delete(response.requestId);
          clearTimeout(pending.timer);
          if (response.ok) pending.resolve(response.result);
          else pending.reject(new RuntimeOwnerRpcError(response.error.code));
        }
      }
    } catch {
      this.close();
    }
  }

  #portRequest(request: ReturnType<typeof parseRuntimeOwnerRpcPortRequest>): void {
    if (
      this.#seenReverseRequestIds.has(request.reverseRequestId) ||
      this.#seenReverseRequestIds.size >= this.#maxReverseRequestsPerConnection
    ) {
      this.close();
      return;
    }
    this.#seenReverseRequestIds.add(request.reverseRequestId);
    if (this.#activePortRequests.size >= this.#maxReverseInFlight) {
      this.#writePortResponse(
        runtimeOwnerRpcPortErrorResponse(request.reverseRequestId, "TOO_MANY_IN_FLIGHT"),
      );
      return;
    }
    const handler = this.#callablePortHandlers.get(
      request.invocation.request.callablePortRef.protectedHandleId,
    );
    if (handler === undefined) {
      this.#writePortResponse(
        runtimeOwnerRpcPortErrorResponse(request.reverseRequestId, "UNAVAILABLE"),
      );
      return;
    }
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      const active = this.#activePortRequests.get(request.reverseRequestId);
      if (active === undefined) return;
      this.#activePortRequests.delete(request.reverseRequestId);
      active.abortController.abort(new RuntimeOwnerRpcError("TIMEOUT"));
      this.#writePortResponse(
        runtimeOwnerRpcPortErrorResponse(request.reverseRequestId, "TIMEOUT"),
      );
    }, this.#requestTimeoutMs);
    timer.unref();
    this.#activePortRequests.set(request.reverseRequestId, { abortController, timer });
    let operation: Promise<RuntimeOwnerRpcPortResult>;
    try {
      operation = Promise.resolve(
        handler(request.invocation, Object.freeze({ signal: abortController.signal })),
      );
    } catch {
      operation = Promise.reject(new RuntimeOwnerRpcError("HANDLER_ERROR"));
    }
    operation.then(
      (result) => this.#settlePortRequest(request.reverseRequestId, result),
      () => this.#failPortRequest(request.reverseRequestId),
    );
  }

  #settlePortRequest(reverseRequestId: string, result: RuntimeOwnerRpcPortResult): void {
    const active = this.#activePortRequests.get(reverseRequestId);
    if (active === undefined) return;
    clearTimeout(active.timer);
    this.#activePortRequests.delete(reverseRequestId);
    try {
      this.#writePortResponse(
        runtimeOwnerRpcPortSuccessResponse(
          reverseRequestId,
          parseRuntimeOwnerInvokePortResult(result),
        ),
      );
    } catch {
      this.#writePortResponse(runtimeOwnerRpcPortErrorResponse(reverseRequestId, "HANDLER_ERROR"));
    }
  }

  #failPortRequest(reverseRequestId: string): void {
    const active = this.#activePortRequests.get(reverseRequestId);
    if (active === undefined) return;
    clearTimeout(active.timer);
    this.#activePortRequests.delete(reverseRequestId);
    this.#writePortResponse(runtimeOwnerRpcPortErrorResponse(reverseRequestId, "HANDLER_ERROR"));
  }

  #writePortResponse(response: unknown): void {
    if (this.#closed || this.#socket.destroyed) return;
    try {
      this.#socket.write(encodeRuntimeOwnerRpcFrame(response));
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
    for (const active of this.#activePortRequests.values()) {
      clearTimeout(active.timer);
      active.abortController.abort(new RuntimeOwnerRpcError(code));
    }
    this.#activePortRequests.clear();
    this.#callablePortHandlers.clear();
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
