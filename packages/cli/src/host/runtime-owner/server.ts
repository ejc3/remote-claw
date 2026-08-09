import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { base64urlEncode } from "@remote-claw/clawsec";
import {
  assertRuntimeOwnerRpcPlatform,
  RuntimeOwnerRpcAuthenticator,
  runtimeOwnerRpcSocketAddress,
} from "./auth.js";
import {
  type RuntimeOwnerCallablePortEntry,
  type RuntimeOwnerCallablePortRegistration,
  RuntimeOwnerCallablePortRegistry,
  type RuntimeOwnerCallablePortRegistryOptions,
} from "./port-registry.js";
import {
  encodeRuntimeOwnerRpcCanonicalJson,
  encodeRuntimeOwnerRpcFrame,
  parseRuntimeOwnerInvokePortRequest,
  parseRuntimeOwnerRpcAuthentication,
  parseRuntimeOwnerRpcPortInvocation,
  parseRuntimeOwnerRpcPortResponse,
  parseRuntimeOwnerRpcRequest,
  RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
  RUNTIME_OWNER_RPC_MAX_CONNECTIONS,
  RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
  RUNTIME_OWNER_RPC_MAX_PREAUTH_BYTES,
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
  runtimeOwnerRpcErrorResponse,
  runtimeOwnerRpcMessageType,
  runtimeOwnerRpcReverseRequestId,
  runtimeOwnerRpcSuccessResponse,
} from "./protocol.js";

export interface RuntimeOwnerRpcRequestContext {
  readonly connectionId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface RuntimeOwnerRpcDetachContext {
  readonly connectionId: string;
}

/** Closed method surface: wire methods call these exact functions, never handler[method]. */
export interface RuntimeOwnerRpcHandler {
  health(context: RuntimeOwnerRpcRequestContext): Promise<RuntimeOwnerRpcJsonValue>;
  dispatch(
    request: RuntimeOwnerRpcDispatchRequest,
    context: RuntimeOwnerRpcRequestContext,
  ): Promise<RuntimeOwnerRpcJsonValue>;
  /** Transport loss releases only this collaborator attachment; it is never a terminate request. */
  detach?(context: RuntimeOwnerRpcDetachContext): void | Promise<void>;
}

export interface StartRuntimeOwnerRpcServerOptions {
  readonly machineIdentityId: string;
  readonly identitySecret: Uint8Array;
  readonly handler: RuntimeOwnerRpcHandler;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxInFlight?: number;
  readonly reverseRequestTimeoutMs?: number;
  readonly maxReverseInFlight?: number;
  readonly maxReverseRequestsPerConnection?: number;
  readonly maxCallablePorts?: number;
  readonly maxCallablePortsPerConnection?: number;
  /** Internal/test seam may lower, but never raise, the fixed protocol request-ID budget. */
  readonly maxRequestsPerConnection?: number;
}

interface ActiveRequest {
  readonly abortController: AbortController;
  readonly timer: NodeJS.Timeout;
}

interface PendingPortRequest {
  readonly invocation: RuntimeOwnerRpcPortInvocation;
  readonly resolve: (value: RuntimeOwnerRpcPortResult) => void;
  readonly reject: (error: RuntimeOwnerRpcError) => void;
  readonly timer: NodeJS.Timeout;
}

interface ConnectionState {
  readonly socket: Socket;
  readonly connectionId: string;
  readonly decoder: RuntimeOwnerRpcFrameDecoder;
  readonly challenge: string;
  readonly seenRequestIds: Set<string>;
  readonly activeRequests: Map<string, ActiveRequest>;
  readonly usedReverseRequestIds: Set<string>;
  readonly pendingPortRequests: Map<string, PendingPortRequest>;
  readonly handshakeTimer: NodeJS.Timeout;
  authenticated: boolean;
  detached: boolean;
  preauthBytes: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  return selected;
}

function validateHandler(value: RuntimeOwnerRpcHandler): RuntimeOwnerRpcHandler {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.health !== "function" ||
    typeof value.dispatch !== "function" ||
    (value.detach !== undefined && typeof value.detach !== "function")
  ) {
    throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
  }
  return value;
}

function safeWrite(socket: Socket, value: unknown): boolean {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.write(encodeRuntimeOwnerRpcFrame(value));
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

export class RuntimeOwnerRpcServer {
  readonly #server: Server;
  readonly #authenticator: RuntimeOwnerRpcAuthenticator;
  readonly #handler: RuntimeOwnerRpcHandler;
  readonly #socketAddress: string;
  readonly #handshakeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxInFlight: number;
  readonly #maxRequestsPerConnection: number;
  readonly #reverseRequestTimeoutMs: number;
  readonly #maxReverseInFlight: number;
  readonly #maxReverseRequestsPerConnection: number;
  readonly #callablePorts: RuntimeOwnerCallablePortRegistry;
  readonly #connections = new Set<ConnectionState>();
  #listening = false;
  #closed = false;

  private constructor(
    authenticator: RuntimeOwnerRpcAuthenticator,
    options: StartRuntimeOwnerRpcServerOptions,
  ) {
    this.#authenticator = authenticator;
    this.#handler = validateHandler(options.handler);
    this.#socketAddress = runtimeOwnerRpcSocketAddress(options.machineIdentityId);
    this.#handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs,
      RUNTIME_OWNER_RPC_DEFAULT_HANDSHAKE_TIMEOUT_MS,
      60_000,
    );
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
      300_000,
    );
    this.#maxInFlight = boundedInteger(
      options.maxInFlight,
      RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
      RUNTIME_OWNER_RPC_MAX_IN_FLIGHT,
    );
    this.#maxRequestsPerConnection = boundedInteger(
      options.maxRequestsPerConnection,
      RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION,
      RUNTIME_OWNER_RPC_MAX_REQUESTS_PER_CONNECTION,
    );
    this.#reverseRequestTimeoutMs = boundedInteger(
      options.reverseRequestTimeoutMs,
      RUNTIME_OWNER_RPC_DEFAULT_REQUEST_TIMEOUT_MS,
      300_000,
    );
    this.#maxReverseInFlight = boundedInteger(
      options.maxReverseInFlight,
      RUNTIME_OWNER_RPC_MAX_REVERSE_IN_FLIGHT,
      RUNTIME_OWNER_RPC_MAX_REVERSE_IN_FLIGHT,
    );
    this.#maxReverseRequestsPerConnection = boundedInteger(
      options.maxReverseRequestsPerConnection,
      RUNTIME_OWNER_RPC_MAX_REVERSE_REQUESTS_PER_CONNECTION,
      RUNTIME_OWNER_RPC_MAX_REVERSE_REQUESTS_PER_CONNECTION,
    );
    const portRegistryOptions: RuntimeOwnerCallablePortRegistryOptions = {
      ...(options.maxCallablePorts === undefined ? {} : { maxPorts: options.maxCallablePorts }),
      ...(options.maxCallablePortsPerConnection === undefined
        ? {}
        : { maxPortsPerConnection: options.maxCallablePortsPerConnection }),
    };
    this.#callablePorts = new RuntimeOwnerCallablePortRegistry(portRegistryOptions);
    this.#server = createServer((socket) => this.#accept(socket));
    this.#server.on("error", () => {
      if (!this.#listening) return;
      this.#listening = false;
      for (const state of this.#connections) state.socket.destroy();
    });
  }

  static async start(options: StartRuntimeOwnerRpcServerOptions): Promise<RuntimeOwnerRpcServer> {
    assertRuntimeOwnerRpcPlatform();
    const authenticator = await RuntimeOwnerRpcAuthenticator.create(
      options.machineIdentityId,
      options.identitySecret,
    );
    try {
      const instance = new RuntimeOwnerRpcServer(authenticator, options);
      await instance.#listen();
      return instance;
    } catch (error) {
      authenticator.close();
      throw error;
    }
  }

  get listening(): boolean {
    return this.#listening && !this.#closed;
  }

  get callablePortCount(): number {
    return this.#callablePorts.size;
  }

  registerCallablePort(
    registration: RuntimeOwnerCallablePortRegistration,
  ): RuntimeOwnerCallablePortEntry {
    const state = this.#findAuthenticatedConnection(registration.connectionId);
    if (state === undefined) throw new RuntimeOwnerRpcError("UNAVAILABLE");
    return this.#callablePorts.register(registration);
  }

  unregisterCallablePort(
    connectionId: string,
    callablePortRef: RuntimeOwnerRpcCallablePortRef,
  ): boolean {
    return this.#callablePorts.unregister(connectionId, callablePortRef);
  }

  invokeCallablePort(
    invocation: RuntimeOwnerRpcPortInvocation,
  ): Promise<RuntimeOwnerRpcPortResult> {
    let parsed: RuntimeOwnerRpcPortInvocation;
    let entry: RuntimeOwnerCallablePortEntry;
    try {
      parsed = parseRuntimeOwnerRpcPortInvocation(invocation);
      entry = this.#callablePorts.authorize(parsed);
    } catch {
      return Promise.reject(new RuntimeOwnerRpcError("UNAVAILABLE"));
    }
    const state = this.#findAuthenticatedConnection(entry.connectionId);
    if (state === undefined || state.socket.destroyed) {
      return Promise.reject(new RuntimeOwnerRpcError("UNAVAILABLE"));
    }
    if (state.pendingPortRequests.size >= this.#maxReverseInFlight) {
      return Promise.reject(new RuntimeOwnerRpcError("TOO_MANY_IN_FLIGHT"));
    }
    if (state.usedReverseRequestIds.size >= this.#maxReverseRequestsPerConnection) {
      state.socket.destroy();
      return Promise.reject(new RuntimeOwnerRpcError("CLOSED"));
    }
    let reverseRequestId: string;
    try {
      reverseRequestId = this.#allocateReverseRequestId(state);
    } catch {
      state.socket.destroy();
      return Promise.reject(new RuntimeOwnerRpcError("UNAVAILABLE"));
    }
    return new Promise<RuntimeOwnerRpcPortResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = state.pendingPortRequests.get(reverseRequestId);
        if (pending === undefined) return;
        state.pendingPortRequests.delete(reverseRequestId);
        pending.reject(new RuntimeOwnerRpcError("TIMEOUT"));
        // No retry may reuse this channel after an outcome whose response arrived late.
        state.socket.destroy();
      }, this.#reverseRequestTimeoutMs);
      timer.unref();
      state.pendingPortRequests.set(reverseRequestId, {
        invocation: parsed,
        resolve,
        reject,
        timer,
      });
      if (
        !safeWrite(state.socket, {
          version: RUNTIME_OWNER_RPC_VERSION,
          type: "port_request",
          reverseRequestId,
          invocation: parsed,
        })
      ) {
        clearTimeout(timer);
        state.pendingPortRequests.delete(reverseRequestId);
        reject(new RuntimeOwnerRpcError("CLOSED"));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listening = false;
    // Detach synchronously before the server-close callback can settle. The service uses detach to
    // register bounded durable cleanup in its shutdown drain; waiting for a later socket `close`
    // event could otherwise release the owner lease before that cleanup even exists.
    for (const state of [...this.#connections]) {
      this.#detach(state);
      state.socket.destroy();
    }
    await new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    this.#authenticator.close();
  }

  #listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (_error: Error): void => {
        this.#server.off("listening", onListening);
        reject(new RuntimeOwnerRpcError("UNAVAILABLE"));
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        this.#listening = true;
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen({ path: this.#socketAddress });
    });
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#connections.size >= RUNTIME_OWNER_RPC_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const challenge = this.#authenticator.createChallenge();
    const handshakeTimer = setTimeout(() => socket.destroy(), this.#handshakeTimeoutMs);
    handshakeTimer.unref();
    const state: ConnectionState = {
      socket,
      connectionId: base64urlEncode(randomBytes(16)),
      decoder: new RuntimeOwnerRpcFrameDecoder(),
      challenge: challenge.challenge,
      seenRequestIds: new Set<string>(),
      activeRequests: new Map<string, ActiveRequest>(),
      usedReverseRequestIds: new Set<string>(),
      pendingPortRequests: new Map<string, PendingPortRequest>(),
      handshakeTimer,
      authenticated: false,
      detached: false,
      preauthBytes: 0,
    };
    this.#connections.add(state);
    socket.on("data", (chunk) => {
      if (typeof chunk === "string") {
        socket.destroy();
        return;
      }
      this.#receive(state, chunk);
    });
    socket.once("error", () => {
      // The close event owns cleanup. Transport/provider text is deliberately not surfaced.
    });
    socket.once("close", () => this.#detach(state));
    safeWrite(socket, {
      version: RUNTIME_OWNER_RPC_VERSION,
      type: "challenge",
      challenge: challenge.challenge,
      serverProof: challenge.serverProof,
    });
  }

  #receive(state: ConnectionState, chunk: Uint8Array): void {
    if (state.socket.destroyed) return;
    try {
      const wasAuthenticated = state.authenticated;
      if (!wasAuthenticated) {
        state.preauthBytes += chunk.byteLength;
        if (state.preauthBytes > RUNTIME_OWNER_RPC_MAX_PREAUTH_BYTES) {
          throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
        }
      }
      const values = state.decoder.push(chunk);
      // Authentication is one exact inbound frame. Requests may begin only after the client has
      // received the authenticated acknowledgement, so pre-auth pipelining cannot consume work.
      if (!wasAuthenticated && values.length > 1) {
        throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
      }
      for (const value of values) {
        if (!state.authenticated) {
          const authentication = parseRuntimeOwnerRpcAuthentication(value);
          if (
            authentication.challenge !== state.challenge ||
            !this.#authenticator.verifyClientProof(state.challenge, authentication.clientProof)
          ) {
            throw new RuntimeOwnerRpcError("AUTHENTICATION_FAILED");
          }
          // The authentication frame must end exactly at the current decoder boundary. A partial
          // request prefix cannot be smuggled across the authenticated acknowledgement.
          state.decoder.end();
          state.authenticated = true;
          state.preauthBytes = 0;
          clearTimeout(state.handshakeTimer);
          if (
            !safeWrite(state.socket, {
              version: RUNTIME_OWNER_RPC_VERSION,
              type: "authenticated",
              challenge: state.challenge,
            })
          ) {
            return;
          }
          continue;
        }
        const messageType = runtimeOwnerRpcMessageType(value);
        if (messageType === "port_response") {
          this.#portResponse(state, parseRuntimeOwnerRpcPortResponse(value));
        } else {
          this.#request(state, parseRuntimeOwnerRpcRequest(value));
        }
      }
    } catch {
      state.socket.destroy();
    }
  }

  #request(state: ConnectionState, request: ReturnType<typeof parseRuntimeOwnerRpcRequest>): void {
    if (
      state.seenRequestIds.has(request.requestId) ||
      state.seenRequestIds.size >= this.#maxRequestsPerConnection
    ) {
      state.socket.destroy();
      return;
    }
    state.seenRequestIds.add(request.requestId);
    if (state.activeRequests.size >= this.#maxInFlight) {
      safeWrite(
        state.socket,
        runtimeOwnerRpcErrorResponse(request.requestId, "TOO_MANY_IN_FLIGHT"),
      );
      return;
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => {
      const active = state.activeRequests.get(request.requestId);
      if (active === undefined) return;
      state.activeRequests.delete(request.requestId);
      active.abortController.abort(new RuntimeOwnerRpcError("TIMEOUT"));
      safeWrite(state.socket, runtimeOwnerRpcErrorResponse(request.requestId, "TIMEOUT"));
    }, this.#requestTimeoutMs);
    timer.unref();
    state.activeRequests.set(request.requestId, { abortController, timer });
    const context = Object.freeze({
      connectionId: state.connectionId,
      requestId: request.requestId,
      signal: abortController.signal,
    });
    let operation: Promise<RuntimeOwnerRpcJsonValue>;
    try {
      operation =
        request.method === "health"
          ? this.#handler.health(context)
          : this.#handler.dispatch(request.params, context);
    } catch {
      operation = Promise.reject(new RuntimeOwnerRpcError("HANDLER_ERROR"));
    }
    Promise.resolve(operation).then(
      (result) => this.#settle(state, request.requestId, result),
      () => this.#fail(state, request.requestId),
    );
  }

  #settle(state: ConnectionState, requestId: string, result: RuntimeOwnerRpcJsonValue): void {
    const active = state.activeRequests.get(requestId);
    if (active === undefined) return;
    clearTimeout(active.timer);
    state.activeRequests.delete(requestId);
    try {
      safeWrite(state.socket, runtimeOwnerRpcSuccessResponse(requestId, result));
    } catch {
      safeWrite(state.socket, runtimeOwnerRpcErrorResponse(requestId, "HANDLER_ERROR"));
    }
  }

  #fail(state: ConnectionState, requestId: string): void {
    const active = state.activeRequests.get(requestId);
    if (active === undefined) return;
    clearTimeout(active.timer);
    state.activeRequests.delete(requestId);
    safeWrite(state.socket, runtimeOwnerRpcErrorResponse(requestId, "HANDLER_ERROR"));
  }

  #portResponse(
    state: ConnectionState,
    response: ReturnType<typeof parseRuntimeOwnerRpcPortResponse>,
  ): void {
    const pending = state.pendingPortRequests.get(response.reverseRequestId);
    if (pending === undefined) {
      // Unknown, replayed, or late reverse responses poison only this collaborator channel.
      state.socket.destroy();
      return;
    }
    state.pendingPortRequests.delete(response.reverseRequestId);
    clearTimeout(pending.timer);
    if (!response.ok) {
      pending.reject(new RuntimeOwnerRpcError(response.error.code));
      return;
    }
    try {
      const echoedRequest = parseRuntimeOwnerInvokePortRequest({
        scopeKind: response.result.scopeKind,
        scopeId: response.result.scopeId,
        callablePortRef: response.result.callablePortRef,
        providerCredential: response.result.providerCredential,
        nativeBindingId: response.result.nativeBindingId,
        runtimeId: response.result.runtimeId,
        fence: response.result.fence,
        operationSchemaId: response.result.operationSchemaId,
        operationRef: response.result.operationRef,
        operationDigest: response.result.operationDigest,
      });
      const expected = encodeRuntimeOwnerRpcCanonicalJson(pending.invocation.request);
      const actual = encodeRuntimeOwnerRpcCanonicalJson(echoedRequest);
      if (!Buffer.from(expected).equals(Buffer.from(actual))) {
        throw new RuntimeOwnerRpcError("PROTOCOL_ERROR");
      }
      pending.resolve(response.result);
    } catch {
      pending.reject(new RuntimeOwnerRpcError("PROTOCOL_ERROR"));
      state.socket.destroy();
    }
  }

  #allocateReverseRequestId(state: ConnectionState): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = runtimeOwnerRpcReverseRequestId(randomBytes(16));
      if (!state.usedReverseRequestIds.has(candidate)) {
        state.usedReverseRequestIds.add(candidate);
        return candidate;
      }
    }
    throw new RuntimeOwnerRpcError("UNAVAILABLE");
  }

  #findAuthenticatedConnection(connectionId: string): ConnectionState | undefined {
    for (const state of this.#connections) {
      if (
        state.connectionId === connectionId &&
        state.authenticated &&
        !state.detached &&
        !state.socket.destroyed
      ) {
        return state;
      }
    }
    return undefined;
  }

  #detach(state: ConnectionState): void {
    if (state.detached) return;
    state.detached = true;
    clearTimeout(state.handshakeTimer);
    this.#connections.delete(state);
    for (const active of state.activeRequests.values()) {
      clearTimeout(active.timer);
      active.abortController.abort(new RuntimeOwnerRpcError("CLOSED"));
    }
    state.activeRequests.clear();
    for (const pending of state.pendingPortRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RuntimeOwnerRpcError("CLOSED"));
    }
    state.pendingPortRequests.clear();
    this.#callablePorts.dropConnection(state.connectionId);
    try {
      state.decoder.end();
    } catch {
      // A truncated final frame is already contained by the closed connection.
    }
    if (!state.authenticated || this.#handler.detach === undefined) return;
    try {
      Promise.resolve(this.#handler.detach({ connectionId: state.connectionId })).catch(() => {
        // Detach callbacks are advisory cleanup and never become a native terminate request.
      });
    } catch {
      // Same fixed detach semantics for synchronous handler failures.
    }
  }
}

export async function startRuntimeOwnerRpcServer(
  options: StartRuntimeOwnerRpcServerOptions,
): Promise<RuntimeOwnerRpcServer> {
  return RuntimeOwnerRpcServer.start(options);
}
