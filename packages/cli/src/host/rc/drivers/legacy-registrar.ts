import { randomUUID } from "node:crypto";
import type { BrokerClient } from "../../../broker/client.js";
import type { Tracer } from "../../../trace.js";
import type {
  NativeConversationBinding,
  NativeConversationCapabilities,
  NativeConversationLease,
  NativeConversationPhase,
  NativeConversationRef,
  NativeConversationRegistrar,
  NativeEngineDescriptor,
  NativeProjectRef,
} from "../../native/adapter.js";
import type { DriverCapabilities, HarnessDescriptor } from "../driver.js";
import type { GitInfo } from "../gitinfo.js";
import type { Session } from "../session.js";
import { type BridgeArgs, type BridgeSessionHandle, startBridgeSession } from "./bridge.js";

/**
 * Viewer-facing metadata carried by the temporary Session-based adapter.
 *
 * The neutral capabilities alongside this metadata describe recovery and
 * mutation evidence. These legacy driver capabilities independently describe
 * which controls today's viewer may expose.
 */
export interface LegacyRcConversationMetadata {
  title: string;
  cwd: string;
  git: GitInfo | null;
  capabilities: DriverCapabilities;
  harness: HarnessDescriptor;
}

export interface LegacyRcRegistrarOptions {
  newClient: () => BrokerClient;
  identityId: Uint8Array;
  relays: Set<Promise<void>>;
  tracer: Tracer;
  /**
   * A0 exposes this process-local value through the neutral lease contract. It
   * is not a durable epoch and does not fence writers across process restarts.
   */
  coordinatorEpoch?: number;
  newBindingId?: () => string;
  startBridge?: (args: BridgeArgs) => BridgeSessionHandle;
}

type LegacyBinding = NativeConversationBinding<Session, LegacyRcConversationMetadata>;

interface OpeningSnapshot {
  requestedBindingId: string | null;
  registrationAttemptId: string;
  descriptor: NativeEngineDescriptor;
  project: NativeProjectRef | null;
  nativeRef: NativeConversationRef | null;
  phase: "starting" | "recovering";
  capabilities: NativeConversationCapabilities | null;
  port: Session;
  metadata: LegacyRcConversationMetadata;
}

interface RegistrationState {
  readonly bindingId: string;
  readonly opening: OpeningSnapshot;
  readonly controller: AbortController;
  readonly lease: NativeConversationLease<LegacyRcConversationMetadata>;
  phase: NativeConversationPhase;
  nativeRef: NativeConversationRef | null;
  capabilities: NativeConversationCapabilities | null;
  metadata: LegacyRcConversationMetadata;
  bridge: BridgeSessionHandle | null;
  stopRequested: boolean;
  tail: Promise<void>;
}

const LEGAL_TRANSITIONS: Readonly<
  Record<NativeConversationPhase, ReadonlySet<NativeConversationPhase>>
> = {
  starting: new Set(["ready", "draining", "closed"]),
  recovering: new Set(["ready", "draining", "closed"]),
  ready: new Set(["draining", "closed"]),
  draining: new Set(["closed"]),
  closed: new Set(["closed"]),
};

function fail(message: string): never {
  throw registrationError(message);
}

function registrationError(message: string): Error {
  return new Error(`legacy RC registration rejected: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptorEqual(a: NativeEngineDescriptor, b: NativeEngineDescriptor): boolean {
  return a.product === b.product && a.access === b.access;
}

function projectEqual(a: NativeProjectRef | null, b: NativeProjectRef | null): boolean {
  return a === b || (a !== null && b !== null && a.projectId === b.projectId && a.cwd === b.cwd);
}

function nativeRefEqual(a: NativeConversationRef | null, b: NativeConversationRef | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      descriptorEqual(a.descriptor, b.descriptor) &&
      a.runtimeId === b.runtimeId &&
      a.conversationId === b.conversationId &&
      a.incarnation === b.incarnation)
  );
}

function nativeCapabilitiesEqual(
  a: NativeConversationCapabilities | null,
  b: NativeConversationCapabilities | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.version === b.version &&
      a.mutationAdmission === b.mutationAdmission &&
      a.history === b.history &&
      a.deliveryEvidence === b.deliveryEvidence &&
      a.liveReattach === b.liveReattach)
  );
}

function driverCapabilitiesEqual(a: DriverCapabilities, b: DriverCapabilities): boolean {
  return (
    a.structuredPermissions === b.structuredPermissions &&
    a.status === b.status &&
    a.attachments === b.attachments &&
    a.controls.interrupt === b.controls.interrupt &&
    a.controls.setModel === b.controls.setModel &&
    a.controls.setMode === b.controls.setMode &&
    a.controls.end === b.controls.end
  );
}

function gitEqual(a: GitInfo | null, b: GitInfo | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.branch === b.branch &&
      a.sha === b.sha &&
      a.dirty === b.dirty &&
      a.ahead === b.ahead &&
      a.behind === b.behind)
  );
}

function harnessEqual(a: HarnessDescriptor, b: HarnessDescriptor): boolean {
  return a.agent === b.agent && a.mode === b.mode;
}

function metadataEqual(a: LegacyRcConversationMetadata, b: LegacyRcConversationMetadata): boolean {
  return (
    a.title === b.title &&
    a.cwd === b.cwd &&
    gitEqual(a.git, b.git) &&
    driverCapabilitiesEqual(a.capabilities, b.capabilities) &&
    harnessEqual(a.harness, b.harness)
  );
}

function cloneDescriptor(value: NativeEngineDescriptor): NativeEngineDescriptor {
  return { product: value.product, access: value.access } as NativeEngineDescriptor;
}

function cloneProject(value: NativeProjectRef | null): NativeProjectRef | null {
  return value === null ? null : { projectId: value.projectId, cwd: value.cwd };
}

function cloneNativeRef(value: NativeConversationRef): NativeConversationRef;
function cloneNativeRef(value: null): null;
function cloneNativeRef(value: NativeConversationRef | null): NativeConversationRef | null;
function cloneNativeRef(value: NativeConversationRef | null): NativeConversationRef | null {
  return value === null
    ? null
    : {
        descriptor: cloneDescriptor(value.descriptor),
        runtimeId: value.runtimeId,
        conversationId: value.conversationId,
        incarnation: value.incarnation,
      };
}

function cloneNativeCapabilities(
  value: NativeConversationCapabilities,
): NativeConversationCapabilities;
function cloneNativeCapabilities(value: null): null;
function cloneNativeCapabilities(
  value: NativeConversationCapabilities | null,
): NativeConversationCapabilities | null;
function cloneNativeCapabilities(
  value: NativeConversationCapabilities | null,
): NativeConversationCapabilities | null {
  return value === null
    ? null
    : {
        version: 1,
        mutationAdmission: value.mutationAdmission,
        history: value.history,
        deliveryEvidence: value.deliveryEvidence,
        liveReattach: value.liveReattach,
      };
}

function cloneDriverCapabilities(value: DriverCapabilities): DriverCapabilities {
  return {
    structuredPermissions: value.structuredPermissions,
    status: value.status,
    attachments: value.attachments,
    controls: {
      interrupt: value.controls.interrupt,
      setModel: value.controls.setModel,
      setMode: value.controls.setMode,
      end: value.controls.end,
    },
  };
}

function cloneGit(value: GitInfo | null): GitInfo | null {
  return value === null
    ? null
    : {
        branch: value.branch,
        sha: value.sha,
        dirty: value.dirty,
        ahead: value.ahead,
        behind: value.behind,
      };
}

function cloneMetadata(value: LegacyRcConversationMetadata): LegacyRcConversationMetadata {
  return {
    title: value.title,
    cwd: value.cwd,
    git: cloneGit(value.git),
    capabilities: cloneDriverCapabilities(value.capabilities),
    harness: { agent: value.harness.agent, mode: value.harness.mode },
  };
}

function assertDescriptor(value: unknown): asserts value is NativeEngineDescriptor {
  if (!isRecord(value)) fail("descriptor must be an object");
  const valid =
    (value.product === "claude-code" &&
      (value.access === "native-rc" || value.access === "tmux")) ||
    (value.product === "codex" && value.access === "app-server") ||
    (value.product === "opencode" && value.access === "server");
  if (!valid) fail("descriptor product/access combination is unsupported");
}

function assertProject(value: unknown): asserts value is NativeProjectRef | null {
  if (value === null) return;
  if (
    !isRecord(value) ||
    typeof value.projectId !== "string" ||
    value.projectId.length === 0 ||
    (value.cwd !== null && typeof value.cwd !== "string")
  ) {
    fail("project must contain a non-empty projectId and nullable cwd");
  }
}

function assertNativeRef(
  value: unknown,
  descriptor: NativeEngineDescriptor,
): asserts value is NativeConversationRef {
  if (!isRecord(value)) fail("native reference must be an object");
  assertDescriptor(value.descriptor);
  if (!descriptorEqual(value.descriptor, descriptor)) {
    fail("native reference descriptor does not match the binding descriptor");
  }
  if (
    typeof value.runtimeId !== "string" ||
    value.runtimeId.length === 0 ||
    typeof value.conversationId !== "string" ||
    value.conversationId.length === 0 ||
    !Number.isSafeInteger(value.incarnation) ||
    (value.incarnation as number) < 0
  ) {
    fail("native reference fields are invalid");
  }
}

function assertNativeCapabilities(value: unknown): asserts value is NativeConversationCapabilities {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !["structured", "mixed", "post_hoc"].includes(value.mutationAdmission as string) ||
    !["none", "partial", "complete"].includes(value.history as string) ||
    !["structured_receipt", "native_observation", "best_effort"].includes(
      value.deliveryEvidence as string,
    ) ||
    typeof value.liveReattach !== "boolean"
  ) {
    fail("native capabilities are invalid or incomplete");
  }
}

function assertDriverCapabilities(value: unknown): asserts value is DriverCapabilities {
  if (
    !isRecord(value) ||
    typeof value.structuredPermissions !== "boolean" ||
    typeof value.status !== "boolean" ||
    typeof value.attachments !== "boolean" ||
    !isRecord(value.controls) ||
    typeof value.controls.interrupt !== "boolean" ||
    typeof value.controls.setModel !== "boolean" ||
    typeof value.controls.setMode !== "boolean" ||
    typeof value.controls.end !== "boolean"
  ) {
    fail("legacy viewer capabilities are invalid or incomplete");
  }
}

function assertGit(value: unknown): asserts value is GitInfo | null {
  if (value === null) return;
  if (
    !isRecord(value) ||
    typeof value.branch !== "string" ||
    typeof value.sha !== "string" ||
    typeof value.dirty !== "boolean" ||
    !Number.isSafeInteger(value.ahead) ||
    (value.ahead as number) < 0 ||
    !Number.isSafeInteger(value.behind) ||
    (value.behind as number) < 0
  ) {
    fail("git metadata is invalid");
  }
}

function assertMetadata(
  value: unknown,
  descriptor: NativeEngineDescriptor,
): asserts value is LegacyRcConversationMetadata {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    typeof value.cwd !== "string" ||
    !isRecord(value.harness)
  ) {
    fail("legacy bridge metadata is invalid");
  }
  assertGit(value.git);
  assertDriverCapabilities(value.capabilities);
  const harness = value.harness;
  const matches =
    (descriptor.product === "claude-code" &&
      descriptor.access === "native-rc" &&
      harness.agent === "claude-code" &&
      harness.mode === "rc") ||
    (descriptor.product === "claude-code" &&
      descriptor.access === "tmux" &&
      harness.agent === "claude-code" &&
      harness.mode === "tmux") ||
    (descriptor.product === "opencode" &&
      descriptor.access === "server" &&
      harness.agent === "opencode" &&
      harness.mode === "opencode");
  if (!matches) fail("legacy harness does not match the native descriptor");
}

function activeNativeIdentityKey(ref: NativeConversationRef): string {
  return JSON.stringify([
    ref.descriptor.product,
    ref.descriptor.access,
    ref.runtimeId,
    ref.conversationId,
  ]);
}

function openingMatches(binding: LegacyBinding, state: RegistrationState): boolean {
  const original = state.opening;
  return (
    binding.bindingId === original.requestedBindingId &&
    binding.registrationAttemptId === original.registrationAttemptId &&
    descriptorEqual(binding.descriptor, original.descriptor) &&
    projectEqual(binding.project, original.project) &&
    nativeRefEqual(binding.nativeRef, original.nativeRef) &&
    binding.phase === original.phase &&
    nativeCapabilitiesEqual(binding.capabilities, original.capabilities) &&
    binding.port === original.port &&
    metadataEqual(binding.metadata, original.metadata)
  );
}

/**
 * A process-local A0 registrar that adapts the current Claude-shaped Session to
 * the neutral host-wide conversation lifecycle.
 *
 * It deliberately has no durable adoption, compare-and-swap, or restart epoch
 * semantics. Unknown caller-provided binding IDs fail closed.
 */
export class LegacyRcConversationRegistrar
  implements NativeConversationRegistrar<Session, LegacyRcConversationMetadata>
{
  readonly #newClient: () => BrokerClient;
  readonly #identityId: Uint8Array;
  readonly #relays: Set<Promise<void>>;
  readonly #tracer: Tracer;
  readonly #coordinatorEpoch: number;
  readonly #newBindingId: () => string;
  readonly #startBridge: (args: BridgeArgs) => BridgeSessionHandle;
  readonly #byAttempt = new Map<string, RegistrationState>();
  readonly #byBinding = new Map<string, RegistrationState>();
  readonly #byPort = new Map<Session, RegistrationState>();
  readonly #bySessionId = new Map<string, RegistrationState>();
  readonly #activeNativeRefs = new Map<string, RegistrationState>();

  constructor(options: LegacyRcRegistrarOptions) {
    const epoch = options.coordinatorEpoch ?? 0;
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      fail("process-local coordinator epoch must be a non-negative safe integer");
    }
    this.#newClient = options.newClient;
    this.#identityId = options.identityId;
    this.#relays = options.relays;
    this.#tracer = options.tracer;
    this.#coordinatorEpoch = epoch;
    this.#newBindingId = options.newBindingId ?? (() => `rcb_${randomUUID().replaceAll("-", "")}`);
    this.#startBridge = options.startBridge ?? startBridgeSession;
  }

  async open(
    binding: LegacyBinding,
  ): Promise<NativeConversationLease<LegacyRcConversationMetadata>> {
    if (
      typeof binding.registrationAttemptId !== "string" ||
      binding.registrationAttemptId.length === 0
    ) {
      fail("registrationAttemptId must be non-empty");
    }

    const priorAttempt = this.#byAttempt.get(binding.registrationAttemptId);
    if (priorAttempt !== undefined) {
      if (!openingMatches(binding, priorAttempt)) {
        fail("registrationAttemptId was reused with a different request");
      }
      return priorAttempt.lease;
    }

    if (binding.bindingId !== null) {
      fail("A0 cannot adopt or reopen a caller-provided bindingId");
    }
    if (binding.phase !== "starting" && binding.phase !== "recovering") {
      fail("initial phase must be starting or recovering");
    }
    assertDescriptor(binding.descriptor);
    assertProject(binding.project);
    assertMetadata(binding.metadata, binding.descriptor);
    if (binding.capabilities !== null) assertNativeCapabilities(binding.capabilities);
    if (binding.nativeRef !== null) assertNativeRef(binding.nativeRef, binding.descriptor);

    const portConflict = this.#byPort.get(binding.port);
    if (portConflict !== undefined) {
      fail(`Session port is already registered as ${portConflict.bindingId}`);
    }
    const sessionIdConflict = this.#bySessionId.get(binding.port.id);
    if (sessionIdConflict !== undefined) {
      fail(`Session id is already registered as ${sessionIdConflict.bindingId}`);
    }
    if (binding.nativeRef !== null) {
      const nativeConflict = this.#activeNativeRefs.get(activeNativeIdentityKey(binding.nativeRef));
      if (nativeConflict !== undefined) {
        fail(`native reference is already active as ${nativeConflict.bindingId}`);
      }
    }

    const bindingId = this.#newBindingId();
    if (!/^rcb_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(bindingId)) {
      fail("generated bindingId must use the rcb_* namespace");
    }
    if (this.#byBinding.has(bindingId)) fail(`generated duplicate bindingId ${bindingId}`);

    const opening: OpeningSnapshot = {
      requestedBindingId: null,
      registrationAttemptId: binding.registrationAttemptId,
      descriptor: cloneDescriptor(binding.descriptor),
      project: cloneProject(binding.project),
      nativeRef: cloneNativeRef(binding.nativeRef),
      phase: binding.phase,
      capabilities: cloneNativeCapabilities(binding.capabilities),
      port: binding.port,
      metadata: cloneMetadata(binding.metadata),
    };
    const state = {} as RegistrationState;
    const lease: NativeConversationLease<LegacyRcConversationMetadata> = {
      bindingId,
      coordinatorEpoch: this.#coordinatorEpoch,
      bindNative: (ref) => {
        if (state.phase === "closed" || state.phase === "draining") {
          return Promise.reject(
            registrationError(`cannot bind native identity while ${state.phase}`),
          );
        }
        if (state.stopRequested) {
          return Promise.reject(
            registrationError("cannot bind native identity after drain was requested"),
          );
        }
        let nextRef: NativeConversationRef;
        try {
          assertNativeRef(ref, state.opening.descriptor);
          nextRef = cloneNativeRef(ref);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.#exclusive(state, () => {
          if (state.stopRequested || state.phase === "closed" || state.phase === "draining") {
            fail(`cannot bind native identity while ${state.phase}`);
          }
          if (state.nativeRef !== null) {
            if (!nativeRefEqual(state.nativeRef, nextRef)) {
              fail("native identity cannot be replaced in A0");
            }
            return;
          }
          const key = activeNativeIdentityKey(nextRef);
          const conflict = this.#activeNativeRefs.get(key);
          if (conflict !== undefined && conflict !== state) {
            fail(`native reference is already active as ${conflict.bindingId}`);
          }
          state.nativeRef = nextRef;
          this.#activeNativeRefs.set(key, state);
        });
      },
      update: (metadata, capabilities) => {
        if (state.phase === "closed") {
          return Promise.reject(registrationError("cannot update a closed lease"));
        }
        if (state.phase === "draining") {
          return Promise.reject(registrationError("cannot update while draining"));
        }
        if (state.stopRequested) {
          return Promise.reject(registrationError("cannot update after drain was requested"));
        }
        let nextMetadata: LegacyRcConversationMetadata;
        let nextCapabilities: NativeConversationCapabilities;
        try {
          assertMetadata(metadata, state.opening.descriptor);
          assertNativeCapabilities(capabilities);
          nextMetadata = cloneMetadata(metadata);
          nextCapabilities = cloneNativeCapabilities(capabilities);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.#exclusive(state, async () => {
          if (state.stopRequested || state.phase === "closed" || state.phase === "draining") {
            fail(`cannot update while ${state.phase}`);
          }
          // Validated native truth is local state; an advisory broker announce
          // cannot roll it back. refresh() may reject to report a delivery gap,
          // while the relay retains this snapshot for its next re-announce.
          state.metadata = nextMetadata;
          state.capabilities = nextCapabilities;
          if (state.bridge !== null) {
            await state.bridge.refresh({
              title: nextMetadata.title,
              cwd: nextMetadata.cwd,
              git: nextMetadata.git,
              capabilities: nextMetadata.capabilities,
            });
          }
          if (state.stopRequested) fail("update completed after drain was requested");
        });
      },
      setPhase: (phase) => {
        if (phase === "draining" || phase === "closed") this.#requestStop(state);
        if (phase === "ready" && state.stopRequested) {
          if (state.phase === "draining" || state.phase === "closed") {
            return Promise.reject(
              registrationError(`illegal phase transition ${state.phase} -> ready`),
            );
          }
          return Promise.reject(registrationError("cannot become ready after drain was requested"));
        }
        return this.#exclusive(state, async () => {
          if (phase === state.phase) return;
          if (!LEGAL_TRANSITIONS[state.phase].has(phase)) {
            fail(`illegal phase transition ${state.phase} -> ${phase}`);
          }
          if (phase === "closed") {
            await this.#closeState(state);
            return;
          }
          if (phase === "ready") {
            if (state.stopRequested) fail("cannot become ready after drain was requested");
            if (state.capabilities === null) {
              fail("validated native capabilities are required before ready");
            }
            if (state.bridge === null) {
              state.bridge = this.#startBridge({
                session: state.opening.port,
                capabilities: state.metadata.capabilities,
                harness: state.metadata.harness,
                newClient: this.#newClient,
                identityId: this.#identityId,
                title: state.metadata.title,
                cwd: state.metadata.cwd,
                git: state.metadata.git,
                signal: state.controller.signal,
                relays: this.#relays,
                tracer: this.#tracer,
              });
            }
          }
          state.phase = phase;
        });
      },
      close: (_reason) => {
        this.#requestStop(state);
        return this.#exclusive(state, () => this.#closeState(state));
      },
    };
    Object.assign(state, {
      bindingId,
      opening,
      controller: new AbortController(),
      lease,
      phase: binding.phase,
      nativeRef: cloneNativeRef(binding.nativeRef),
      capabilities: cloneNativeCapabilities(binding.capabilities),
      metadata: cloneMetadata(binding.metadata),
      bridge: null,
      stopRequested: false,
      tail: Promise.resolve(),
    } satisfies RegistrationState);

    this.#byAttempt.set(binding.registrationAttemptId, state);
    this.#byBinding.set(bindingId, state);
    this.#byPort.set(binding.port, state);
    this.#bySessionId.set(binding.port.id, state);
    if (state.nativeRef !== null) {
      this.#activeNativeRefs.set(activeNativeIdentityKey(state.nativeRef), state);
    }
    return lease;
  }

  /** Close a stable snapshot so registrations racing after this call are not accidentally captured. */
  async closeAll(reason: string): Promise<void> {
    const leases = [...this.#byBinding.values()].map((state) => state.lease);
    await Promise.all(leases.map((lease) => lease.close(reason)));
  }

  #exclusive<T>(state: RegistrationState, operation: () => T | Promise<T>): Promise<T> {
    const result = state.tail.then(operation, operation);
    state.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  #requestStop(state: RegistrationState): void {
    state.stopRequested = true;
    state.controller.abort();
  }

  async #closeState(state: RegistrationState): Promise<void> {
    if (state.phase === "closed") return;
    state.phase = "closed";
    this.#requestStop(state);
    try {
      if (state.bridge !== null) await state.bridge.served;
    } finally {
      if (state.nativeRef !== null) {
        const key = activeNativeIdentityKey(state.nativeRef);
        if (this.#activeNativeRefs.get(key) === state) this.#activeNativeRefs.delete(key);
      }
    }
  }
}
