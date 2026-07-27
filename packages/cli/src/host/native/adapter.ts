/**
 * A native client product that remote-claw can host.
 */
export type EngineProduct = "claude-code" | "codex" | "opencode";

/**
 * The native control surface used to reach an engine.
 */
export type EngineAccess = "native-rc" | "app-server" | "server" | "tmux";

/**
 * The supported product/control-surface combinations.
 */
export type NativeEngineDescriptor =
  | { product: "claude-code"; access: "native-rc" | "tmux" }
  | { product: "codex"; access: "app-server" }
  | { product: "opencode"; access: "server" };

/**
 * A proven native conversation identity.
 *
 * This is the engine's semantic session or thread identity, not a synthetic
 * remote-control or provider transport identifier.
 */
export interface NativeConversationRef {
  descriptor: NativeEngineDescriptor;
  /** One engine daemon, server, process tree, or supervised runtime. */
  runtimeId: string;
  /** The stable semantic native session or thread. */
  conversationId: string;
  /** Monotonic native binding incarnation, not coordinator order. */
  incarnation: number;
}

export interface NativeProjectRef {
  projectId: string;
  cwd: string | null;
}

/**
 * Capabilities established from the running adapter after setup.
 */
export interface NativeConversationCapabilities {
  version: 1;
  mutationAdmission: "structured" | "mixed" | "post_hoc";
  history: "none" | "partial" | "complete";
  deliveryEvidence: "structured_receipt" | "native_observation" | "best_effort";
  liveReattach: boolean;
}

export type NativeConversationPhase = "starting" | "ready" | "recovering" | "draining" | "closed";

/**
 * The adapter's initial registration request.
 *
 * An open request is explicitly either starting a new runtime or recovering an
 * existing one. Native identity and post-setup capabilities remain null until
 * the adapter can establish them truthfully.
 */
export interface NativeConversationBinding<TPort = unknown, TMetadata = unknown> {
  /** Null for discovery/new binding; persisted for explicit resume/adoption. */
  bindingId: string | null;
  /** Stable across retries of this registration attempt. */
  registrationAttemptId: string;
  descriptor: NativeEngineDescriptor;
  project: NativeProjectRef | null;
  nativeRef: NativeConversationRef | null;
  phase: "starting" | "recovering";
  capabilities: NativeConversationCapabilities | null;
  port: TPort;
  metadata: TMetadata;
}

export interface NativeConversationLease<TMetadata = unknown> {
  readonly bindingId: string;
  readonly coordinatorEpoch: number;

  /**
   * Bind the first proven native identity.
   *
   * A0 registrars accept the first reference and exact replays only. A
   * different reference must fail closed; forward-incarnation recovery is a
   * separate, proof-carrying transition introduced after A0.
   */
  bindNative(ref: NativeConversationRef): Promise<void>;

  /**
   * Commit validated post-setup metadata and capabilities without changing
   * the native identity. An implementation may reject when advisory projection
   * delivery fails, but that delivery failure does not roll back native truth.
   */
  update(metadata: TMetadata, capabilities: NativeConversationCapabilities): Promise<void>;

  setPhase(phase: NativeConversationPhase): Promise<void>;

  /**
   * Idempotently close this bridge lease. Closing a lease does not itself
   * terminate the native runtime.
   */
  close(reason: string): Promise<void>;
}

export interface NativeMutationFence {
  bindingId: string;
  coordinatorEpoch: number;
  attemptId: string;
  nativeRef: NativeConversationRef;
}

export interface NativeConversationRegistrar<TPort = unknown, TMetadata = unknown> {
  open(
    binding: NativeConversationBinding<TPort, TMetadata>,
  ): Promise<NativeConversationLease<TMetadata>>;
}

/**
 * A native engine contributes conversations to a host-wide registrar.
 *
 * The contract is deliberately independent of the Claude RC Session and all
 * other engine-specific transport types.
 */
export interface NativeEngineAdapter<TPort = unknown, TMetadata = unknown> {
  readonly descriptor: NativeEngineDescriptor;
  run(registrar: NativeConversationRegistrar<TPort, TMetadata>, signal: AbortSignal): Promise<void>;
}
