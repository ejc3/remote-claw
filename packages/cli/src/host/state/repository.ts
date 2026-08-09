import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import type { NativeEngineDescriptor } from "../native/adapter.js";
import {
  type A1Digest,
  type A1SafeId,
  type CollaborationServerId,
  type CoordinatorLeaseId,
  HostStateContractError,
  type InwardEdgeId,
  type LogicalChatId,
  type NativeBindingId,
  type ProjectId,
  type ProjectTargetSelectorMappingId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseMachineIdentityId,
  type RegistrationAttemptId,
} from "./ids.js";
import {
  type CollaborationServerRecord,
  type CoordinatorLeaseFence,
  type CoordinatorLeaseRecord,
  type HostStateProfileRecord,
  type LogicalChatRecord,
  type NativeBindingRecord,
  type NativeRegistrationIntentRecord,
  type ProjectRecord,
  type ProjectTarget,
  type ProjectTargetSelectorMappingRecord,
  parseCollaborationServerRecord,
  parseCoordinatorLeaseFence,
  parseCoordinatorLeaseRecord,
  parseHostStateProfileRecord,
  parseLogicalChatRecord,
  parseNativeBindingRecord,
  parseNativeEngineDescriptor,
  parseNativeRegistrationIntentRecord,
  parseProjectRecord,
  parseProjectTarget,
  parseProjectTargetSelectorMappingRecord,
} from "./records.js";
import {
  type InwardCollaborationEdgeRecord,
  parseInwardCollaborationEdgeRecord,
} from "./runtime.js";
import {
  frozen,
  parseEnum,
  parseExactRecord,
  parseLiteral,
  parseNonEmptyString,
  parseNonNegativeSafeInteger,
  parseNullable,
  parsePositiveSafeInteger,
  type UnknownRecord,
} from "./validation.js";

export const HOST_STATE_REPOSITORY_MAX_ID_ATTEMPTS = 8;

export const HOST_STATE_JOURNAL_SCHEMA_IDS = Object.freeze({
  project_bootstrapped: "remote-claw/project-bootstrap/v1",
  terminal_chat_reserved: "remote-claw/terminal-chat-reservation/v1",
  project_target_mapping_replaced: "remote-claw/project-target-mapping-replacement/v1",
  coordinator_lease_acquired: "remote-claw/coordinator-lease-acquisition/v1",
  coordinator_lease_released: "remote-claw/coordinator-lease-release/v1",
} as const);

export type HostStateJournalEntryKind = keyof typeof HOST_STATE_JOURNAL_SCHEMA_IDS;
export type HostStateJournalSubjectKind =
  | "project"
  | "logical_chat"
  | "project_target_mapping"
  | "coordinator_lease";
export type HostStateRepositorySqlValue = string | number | Uint8Array | null;

export interface HostStateRepositorySqlRunResult {
  readonly changes: number | bigint;
}

/** Private synchronous SQL seam implemented by the secure SQLite kernel. */
export interface HostStateRepositorySqlTransaction {
  get(sql: string, parameters: readonly HostStateRepositorySqlValue[]): unknown;
  /**
   * A1.1's public transaction type predates repository inventory reads. The
   * concrete secure-SQLite transaction supplies this method; keeping it
   * optional preserves structural composition with the narrower A1.1 type.
   */
  readonly all?: (
    sql: string,
    parameters: readonly HostStateRepositorySqlValue[],
  ) => readonly unknown[];
  run(
    sql: string,
    parameters: readonly HostStateRepositorySqlValue[],
  ): HostStateRepositorySqlRunResult;
}

/** The executor must reject nested and asynchronous callbacks, as A1.1 does. */
export interface HostStateRepositoryTransactionExecutor {
  transaction<T>(operation: (transaction: HostStateRepositorySqlTransaction) => T): T;
}

export class HostStateRepositoryConflictError extends Error {
  constructor(message: string) {
    super(`host state repository conflict: ${message}`);
    this.name = "HostStateRepositoryConflictError";
  }
}

export class HostStateStaleCoordinatorError extends Error {
  constructor(message = "coordinator lease fence is not current and unexpired") {
    super(`host state repository stale coordinator: ${message}`);
    this.name = "HostStateStaleCoordinatorError";
  }
}

export class HostStateRepositoryPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`host state repository persistence failed: ${message}`, options);
    this.name = "HostStateRepositoryPersistenceError";
  }
}

export type HostStateActorScope =
  | Readonly<{
      collaborationServerId: CollaborationServerId;
      scopeKind: "server_control";
      logicalChatId: null;
    }>
  | Readonly<{
      collaborationServerId: CollaborationServerId;
      scopeKind: "chat";
      logicalChatId: LogicalChatId;
    }>;

const ACTOR_SCOPE_KEYS = ["collaborationServerId", "scopeKind", "logicalChatId"] as const;

export function parseHostStateActorScope(value: unknown): HostStateActorScope {
  const row = parseExactRecord(value, ACTOR_SCOPE_KEYS, "actorScope");
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    row.collaborationServerId,
    "actorScope.collaborationServerId",
  );
  const scopeKind = parseEnum(
    row.scopeKind,
    ["server_control", "chat"] as const,
    "actorScope.scopeKind",
  );
  if (scopeKind === "server_control") {
    if (row.logicalChatId !== null) {
      throw new HostStateContractError(
        "actorScope.logicalChatId must be null for a server-control actor",
      );
    }
    return frozen({
      collaborationServerId,
      scopeKind,
      logicalChatId: null,
    }) as HostStateActorScope;
  }
  if (row.logicalChatId === null) {
    throw new HostStateContractError("actorScope.logicalChatId must be present for a chat actor");
  }
  return frozen({
    collaborationServerId,
    scopeKind,
    logicalChatId: parseA1CanonicalId("logicalChat", row.logicalChatId, "actorScope.logicalChatId"),
  });
}

export interface TerminalRegistrationInput {
  readonly registrationAttemptId: RegistrationAttemptId;
  readonly descriptor: NativeEngineDescriptor;
  readonly descriptorRef: A1SafeId;
  readonly descriptorDigest: A1Digest;
  readonly projectRef: A1SafeId;
  readonly projectDigest: A1Digest;
  readonly expectedNativeRefDigest: A1Digest | null;
  readonly initialPhase: "starting" | "recovering";
  readonly metadataSchemaId: string;
  readonly metadataRef: A1SafeId;
  readonly metadataDigest: A1Digest;
  readonly capabilitiesRef: A1SafeId | null;
  readonly capabilitiesDigest: A1Digest | null;
}

export interface ProjectTargetMappingFence {
  readonly projectId: ProjectId;
  readonly workspaceSelectorId: A1SafeId;
  readonly projectTargetSelectorMappingId: ProjectTargetSelectorMappingId;
  readonly mappingGeneration: number;
  readonly targetDigest: A1Digest;
}

export interface ReserveFirstTerminalChatRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly workspaceSelectorId: A1SafeId;
  readonly terminalTarget: Extract<ProjectTarget, { readonly kind: "terminal_native" }>;
  readonly mappingEvidenceRef: A1SafeId;
  readonly registration: TerminalRegistrationInput;
}

export interface ReserveAdditionalTerminalChatRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly mappingFence: ProjectTargetMappingFence;
  readonly parentChatId: LogicalChatId | null;
  readonly registration: TerminalRegistrationInput;
}

export interface AllocateExplicitProjectRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly projectAllocationIntentId: A1SafeId;
  readonly workspaceSelectorId: A1SafeId;
  readonly terminalTarget: Extract<ProjectTarget, { readonly kind: "terminal_native" }>;
  readonly mappingEvidenceRef: A1SafeId;
}

export interface AllocateExplicitProjectResult {
  readonly project: ProjectRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
  readonly journalEntry: HostStateJournalEntry;
  readonly replayed: boolean;
}

export interface ReplaceProjectTargetMappingRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly expectedMapping: ProjectTargetMappingFence;
  readonly terminalTarget: Extract<ProjectTarget, { readonly kind: "terminal_native" }>;
  readonly mappingEvidenceRef: A1SafeId;
}

export interface ReplaceProjectTargetMappingResult {
  readonly project: ProjectRecord;
  readonly previousMapping: ProjectTargetSelectorMappingRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
  readonly journalEntry: HostStateJournalEntry;
  readonly replayed: boolean;
}

export type ReconcileProjectTargetMappingReplacementResult =
  | Readonly<{
      status: "applied";
      replacement: ReplaceProjectTargetMappingResult;
    }>
  | Readonly<{
      status: "not_applied" | "collision";
      replacement: null;
    }>;

export interface HostStateJournalEntry {
  readonly collaborationServerId: CollaborationServerId;
  readonly journalOffset: number;
  readonly scopeKind: "server_control" | "chat";
  readonly logicalChatId: LogicalChatId | null;
  readonly entryKind: HostStateJournalEntryKind;
  readonly subjectKind: HostStateJournalSubjectKind;
  readonly subjectId: A1SafeId;
  readonly entrySchemaId: (typeof HOST_STATE_JOURNAL_SCHEMA_IDS)[HostStateJournalEntryKind];
  readonly entryDigest: A1Digest;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly coordinatorEpoch: number;
  readonly committedAtMs: number;
}

export interface TerminalChatReservationResult {
  readonly project: ProjectRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
  readonly chat: LogicalChatRecord;
  readonly binding: NativeBindingRecord;
  readonly registrationIntent: NativeRegistrationIntentRecord;
  readonly edge: InwardCollaborationEdgeRecord;
  readonly journalEntry: HostStateJournalEntry;
  readonly replayed: boolean;
}

export interface DefaultCollaborationServerResult {
  readonly profile: HostStateProfileRecord;
  readonly server: CollaborationServerRecord;
  readonly created: boolean;
}

export interface AcquireCoordinatorLeaseRequest {
  readonly collaborationServerId: CollaborationServerId;
  readonly candidateLeaseId: CoordinatorLeaseId;
  readonly ownerInstanceId: A1SafeId;
  readonly expectedCurrentLeaseId: CoordinatorLeaseId | null;
  readonly expectedCoordinatorEpoch: number;
  readonly leaseDurationMs: number;
}

export interface AcquireCoordinatorLeaseResult {
  readonly lease: CoordinatorLeaseRecord;
  readonly journalEntry: HostStateJournalEntry;
  readonly replayed: boolean;
  readonly isCurrent: boolean;
  readonly unexpired: boolean;
}

export interface RenewCoordinatorLeaseRequest {
  readonly fence: CoordinatorLeaseFence;
  readonly expectedHeartbeatDeadlineMs: number;
  readonly newHeartbeatDeadlineMs: number;
}

export interface RenewCoordinatorLeaseResult {
  readonly lease: CoordinatorLeaseRecord;
  readonly replayed: boolean;
}

export interface ReleaseCoordinatorLeaseRequest {
  readonly fence: CoordinatorLeaseFence;
}

export interface ReleaseCoordinatorLeaseResult {
  readonly lease: CoordinatorLeaseRecord;
  readonly journalEntry: HostStateJournalEntry;
}

export interface ReconcileCoordinatorRenewalRequest {
  readonly collaborationServerId: CollaborationServerId;
  readonly coordinatorLeaseId: CoordinatorLeaseId;
  readonly expectedHeartbeatDeadlineMs: number;
  readonly newHeartbeatDeadlineMs: number;
}

export interface ReconcileCoordinatorRenewalResult {
  readonly lease: CoordinatorLeaseRecord;
  readonly status: "applied" | "not_applied" | "superseded_or_indeterminate";
}

export interface ReconcileCoordinatorReleaseResult {
  readonly lease: CoordinatorLeaseRecord;
  readonly releaseJournalEntry: HostStateJournalEntry | null;
  readonly status: "released" | "not_released" | "superseded_or_indeterminate";
}

/**
 * Narrow high-level surface exposed by the secure host-state database. Raw SQL,
 * clocks, entropy, and repository construction remain integration details.
 */
export interface HostStateRepositoryOperations {
  ensureDefaultCollaborationServer(): DefaultCollaborationServerResult;
  allocateExplicitProject(request: AllocateExplicitProjectRequest): AllocateExplicitProjectResult;
  replaceProjectTargetMapping(
    request: ReplaceProjectTargetMappingRequest,
  ): ReplaceProjectTargetMappingResult;
  reconcileProjectTargetMappingReplacement(
    request: ReplaceProjectTargetMappingRequest,
  ): ReconcileProjectTargetMappingReplacementResult;
  reserveFirstTerminalChat(request: ReserveFirstTerminalChatRequest): TerminalChatReservationResult;
  reserveAdditionalTerminalChat(
    request: ReserveAdditionalTerminalChatRequest,
  ): TerminalChatReservationResult;
  acquireCoordinatorLease(request: AcquireCoordinatorLeaseRequest): AcquireCoordinatorLeaseResult;
  reconcileCoordinatorAcquisition(
    request: AcquireCoordinatorLeaseRequest,
  ): AcquireCoordinatorLeaseResult | null;
  renewCoordinatorLease(request: RenewCoordinatorLeaseRequest): RenewCoordinatorLeaseResult;
  releaseCoordinatorLease(request: ReleaseCoordinatorLeaseRequest): ReleaseCoordinatorLeaseResult;
  reconcileCoordinatorRenewal(
    request: ReconcileCoordinatorRenewalRequest,
  ): ReconcileCoordinatorRenewalResult | null;
  reconcileCoordinatorRelease(
    collaborationServerId: CollaborationServerId,
    coordinatorLeaseId: CoordinatorLeaseId,
  ): ReconcileCoordinatorReleaseResult | null;
  readDefaultCollaborationServer(): DefaultCollaborationServerResult | null;
  readProjectAllocation(
    collaborationServerId: CollaborationServerId,
    projectAllocationIntentId: A1SafeId,
  ): AllocateExplicitProjectResult | null;
  listProjects(collaborationServerId: CollaborationServerId): readonly ProjectRecord[];
  listProjectTargetMappings(
    collaborationServerId: CollaborationServerId,
    projectId: ProjectId,
    workspaceSelectorId: A1SafeId,
  ): readonly ProjectTargetSelectorMappingRecord[];
  readCurrentProjectTargetMapping(
    collaborationServerId: CollaborationServerId,
    projectId: ProjectId,
    workspaceSelectorId: A1SafeId,
  ): ProjectTargetSelectorMappingRecord | null;
  readTerminalReservation(
    collaborationServerId: CollaborationServerId,
    registrationAttemptId: RegistrationAttemptId,
  ): TerminalChatReservationResult | null;
  listTerminalReservations(
    collaborationServerId: CollaborationServerId,
    projectId?: ProjectId,
  ): readonly TerminalChatReservationResult[];
  readLogicalChat(
    collaborationServerId: CollaborationServerId,
    logicalChatId: LogicalChatId,
  ): LogicalChatRecord | null;
  listLogicalChats(
    collaborationServerId: CollaborationServerId,
    projectId: ProjectId,
  ): readonly LogicalChatRecord[];
  listNativeBindings(
    collaborationServerId: CollaborationServerId,
    logicalChatId: LogicalChatId,
  ): readonly NativeBindingRecord[];
  readCoordinatorLease(
    collaborationServerId: CollaborationServerId,
    coordinatorLeaseId: CoordinatorLeaseId,
  ): CoordinatorLeaseRecord | null;
  readCoordinatorLeaseAcquisition(
    collaborationServerId: CollaborationServerId,
    coordinatorLeaseId: CoordinatorLeaseId,
  ): AcquireCoordinatorLeaseResult | null;
}

export interface HostStateRepositoryOptions {
  readonly randomBytes?: (byteLength: number) => Uint8Array;
  readonly nowMs?: () => number;
}

const REGISTRATION_KEYS = [
  "registrationAttemptId",
  "descriptor",
  "descriptorRef",
  "descriptorDigest",
  "projectRef",
  "projectDigest",
  "expectedNativeRefDigest",
  "initialPhase",
  "metadataSchemaId",
  "metadataRef",
  "metadataDigest",
  "capabilitiesRef",
  "capabilitiesDigest",
] as const;

function parseTerminalRegistrationInput(value: unknown): TerminalRegistrationInput {
  const row = parseExactRecord(value, REGISTRATION_KEYS, "terminalRegistration");
  const capabilitiesRef = parseNullable(
    row.capabilitiesRef,
    parseA1SafeId,
    "terminalRegistration.capabilitiesRef",
  );
  const capabilitiesDigest = parseNullable(
    row.capabilitiesDigest,
    parseA1Digest,
    "terminalRegistration.capabilitiesDigest",
  );
  if ((capabilitiesRef === null) !== (capabilitiesDigest === null)) {
    throw new HostStateContractError(
      "terminalRegistration capabilities reference and digest must both be absent or present",
    );
  }
  return frozen({
    registrationAttemptId: parseA1CanonicalId(
      "registrationAttempt",
      row.registrationAttemptId,
      "terminalRegistration.registrationAttemptId",
    ),
    descriptor: parseNativeEngineDescriptor(row.descriptor, "terminalRegistration.descriptor"),
    descriptorRef: parseA1SafeId(row.descriptorRef, "terminalRegistration.descriptorRef"),
    descriptorDigest: parseA1Digest(row.descriptorDigest, "terminalRegistration.descriptorDigest"),
    projectRef: parseA1SafeId(row.projectRef, "terminalRegistration.projectRef"),
    projectDigest: parseA1Digest(row.projectDigest, "terminalRegistration.projectDigest"),
    expectedNativeRefDigest: parseNullable(
      row.expectedNativeRefDigest,
      parseA1Digest,
      "terminalRegistration.expectedNativeRefDigest",
    ),
    initialPhase: parseEnum(
      row.initialPhase,
      ["starting", "recovering"] as const,
      "terminalRegistration.initialPhase",
    ),
    metadataSchemaId: parseNonEmptyString(
      row.metadataSchemaId,
      "terminalRegistration.metadataSchemaId",
    ),
    metadataRef: parseA1SafeId(row.metadataRef, "terminalRegistration.metadataRef"),
    metadataDigest: parseA1Digest(row.metadataDigest, "terminalRegistration.metadataDigest"),
    capabilitiesRef,
    capabilitiesDigest,
  });
}

function digestBytes(value: unknown, field: string): Uint8Array {
  return base64urlDecode(parseA1Digest(value, field));
}

function finishDigest(writer: CanonicalWriter): A1Digest {
  return parseA1Digest(createHash("sha256").update(writer.finish()).digest("base64url"));
}

function equalDigest(left: A1Digest, right: A1Digest): boolean {
  return timingSafeEqual(base64urlDecode(left), base64urlDecode(right));
}

/** Synchronous Node counterpart to the cross-runtime project-target vector. */
export function syncProjectTargetDigest(value: ProjectTarget): A1Digest {
  const target = parseProjectTarget(value);
  const writer = new CanonicalWriter();
  if (target.kind === "terminal_native") {
    writer.str("remote-claw/project-target/terminal-native/v1");
    writer.str(target.kind);
    writer.str(target.descriptor.product);
    writer.str(target.descriptor.access);
    writer.str(target.terminalProjectRef);
    writer.optionalStr(target.nativeWorkspaceBindingId);
  } else {
    writer.str("remote-claw/project-target/nested-server/v1");
    writer.str(target.kind);
    writer.str(target.nestedServerManagementBindingId);
    writer.str(target.targetServerId);
    writer.str(target.targetProjectId);
    writer.str(target.targetWorkspaceSelectorId);
  }
  return finishDigest(writer);
}

export function syncProjectTargetSelectorMappingId(
  value: Pick<
    ProjectTargetSelectorMappingRecord,
    | "collaborationServerId"
    | "projectId"
    | "workspaceSelectorId"
    | "mappingGeneration"
    | "targetDigest"
  >,
): ProjectTargetSelectorMappingId {
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    value.collaborationServerId,
  );
  const projectId = parseA1CanonicalId("project", value.projectId);
  const workspaceSelectorId = parseA1SafeId(value.workspaceSelectorId);
  const mappingGeneration = parsePositiveSafeInteger(
    value.mappingGeneration,
    "projectTargetSelectorMapping.mappingGeneration",
  );
  const targetDigest = parseA1Digest(value.targetDigest);
  const writer = new CanonicalWriter();
  writer.str("remote-claw/project-target-selector/v1");
  writer.str(collaborationServerId);
  writer.str(projectId);
  writer.str(workspaceSelectorId);
  writer.uint(mappingGeneration);
  writer.bytes(digestBytes(targetDigest, "projectTargetSelectorMapping.targetDigest"));
  return parseA1CanonicalId(
    "projectTargetSelectorMapping",
    `ptm_${base64urlEncode(createHash("sha256").update(writer.finish()).digest())}`,
  );
}

export function syncProjectAllocationIntentDigest(
  value: Pick<
    ProjectRecord,
    | "projectAllocationIntentSchemaId"
    | "projectAllocationIntentId"
    | "collaborationServerId"
    | "projectId"
    | "allocationKind"
    | "initialWorkspaceSelectorId"
    | "initialTargetDigest"
  >,
): A1Digest {
  const schemaId = parseLiteral(
    value.projectAllocationIntentSchemaId,
    "remote-claw/project-allocation-intent/v1",
    "projectAllocationIntent.projectAllocationIntentSchemaId",
  );
  const allocationKind = parseEnum(
    value.allocationKind,
    ["first_bootstrap", "explicit_new_project"] as const,
    "projectAllocationIntent.allocationKind",
  );
  const intentId =
    allocationKind === "first_bootstrap"
      ? parseA1CanonicalId("registrationAttempt", value.projectAllocationIntentId)
      : parseA1SafeId(value.projectAllocationIntentId);
  const serverId = parseA1CanonicalId("collaborationServer", value.collaborationServerId);
  const projectId = parseA1CanonicalId("project", value.projectId);
  const selectorId = parseA1SafeId(value.initialWorkspaceSelectorId);
  const targetDigest = parseA1Digest(value.initialTargetDigest);
  const writer = new CanonicalWriter();
  writer.str(schemaId);
  writer.str(intentId);
  writer.str(serverId);
  writer.str(projectId);
  writer.str(allocationKind);
  writer.str(selectorId);
  writer.bytes(digestBytes(targetDigest, "projectAllocationIntent.initialTargetDigest"));
  return finishDigest(writer);
}

export function syncNativeRegistrationIntentDigest(
  value: Pick<
    NativeRegistrationIntentRecord,
    | "canonicalIntentSchemaId"
    | "registrationAttemptId"
    | "collaborationServerId"
    | "nativeBindingId"
    | "descriptorRef"
    | "descriptorDigest"
    | "projectRef"
    | "projectDigest"
    | "expectedNativeRefDigest"
    | "initialPhase"
    | "metadataSchemaId"
    | "metadataRef"
    | "metadataDigest"
    | "capabilitiesRef"
    | "capabilitiesDigest"
  >,
): A1Digest {
  const parsed = parseNativeRegistrationIntentRecord({
    ...value,
    canonicalIntentDigest: base64urlEncode(new Uint8Array(32)),
    createdAtMs: 0,
  });
  const writer = new CanonicalWriter();
  writer.str(parsed.canonicalIntentSchemaId);
  writer.str(parsed.registrationAttemptId);
  writer.str(parsed.collaborationServerId);
  writer.str(parsed.nativeBindingId);
  writer.str(parsed.descriptorRef);
  writer.bytes(digestBytes(parsed.descriptorDigest, "nativeRegistrationIntent.descriptorDigest"));
  writer.str(parsed.projectRef);
  writer.bytes(digestBytes(parsed.projectDigest, "nativeRegistrationIntent.projectDigest"));
  writer.optionalBytes(
    parsed.expectedNativeRefDigest === null
      ? null
      : digestBytes(
          parsed.expectedNativeRefDigest,
          "nativeRegistrationIntent.expectedNativeRefDigest",
        ),
  );
  writer.str(parsed.initialPhase);
  writer.str(parsed.metadataSchemaId);
  writer.str(parsed.metadataRef);
  writer.bytes(digestBytes(parsed.metadataDigest, "nativeRegistrationIntent.metadataDigest"));
  writer.optionalStr(parsed.capabilitiesRef);
  writer.optionalBytes(
    parsed.capabilitiesDigest === null
      ? null
      : digestBytes(parsed.capabilitiesDigest, "nativeRegistrationIntent.capabilitiesDigest"),
  );
  return finishDigest(writer);
}

export function syncHostStateJournalEntryDigest(
  value: Omit<HostStateJournalEntry, "entryDigest">,
): A1Digest {
  const writer = new CanonicalWriter();
  writer.str(value.entrySchemaId);
  writer.str(value.collaborationServerId);
  writer.uint(value.journalOffset);
  writer.str(value.scopeKind);
  writer.optionalStr(value.logicalChatId);
  writer.str(value.entryKind);
  writer.str(value.subjectKind);
  writer.str(value.subjectId);
  writer.str(value.coordinatorLeaseId);
  writer.uint(value.coordinatorEpoch);
  writer.uint(value.committedAtMs);
  return finishDigest(writer);
}

function sqlGet(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): unknown {
  try {
    return transaction.get(sql, parameters);
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof HostStateRepositoryConflictError ||
      error instanceof HostStateStaleCoordinatorError ||
      error instanceof HostStateRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new HostStateRepositoryPersistenceError("read operation did not complete", {
      cause: error,
    });
  }
}

function sqlAll(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[] = [],
): readonly unknown[] {
  try {
    if (transaction.all === undefined) {
      throw new HostStateRepositoryPersistenceError(
        "repository inventory reads require a multi-row SQL transaction",
      );
    }
    const rows = transaction.all(sql, parameters);
    if (!Array.isArray(rows)) {
      throw new HostStateRepositoryPersistenceError("multi-row read returned a non-array result");
    }
    return rows;
  } catch (error) {
    if (error instanceof HostStateRepositoryPersistenceError) throw error;
    throw new HostStateRepositoryPersistenceError("multi-row read did not complete", {
      cause: error,
    });
  }
}

function sqlRun(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
): number {
  try {
    const changes = transaction.run(sql, parameters).changes;
    const numeric = typeof changes === "bigint" ? Number(changes) : changes;
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new HostStateRepositoryPersistenceError("write returned an invalid change count");
    }
    return numeric;
  } catch (error) {
    if (
      error instanceof HostStateContractError ||
      error instanceof HostStateRepositoryConflictError ||
      error instanceof HostStateStaleCoordinatorError ||
      error instanceof HostStateRepositoryPersistenceError
    ) {
      throw error;
    }
    throw new HostStateRepositoryPersistenceError("write operation did not complete", {
      cause: error,
    });
  }
}

function runExactlyOne(
  transaction: HostStateRepositorySqlTransaction,
  sql: string,
  parameters: readonly HostStateRepositorySqlValue[],
  operation: string,
): void {
  if (sqlRun(transaction, sql, parameters) !== 1) {
    throw new HostStateRepositoryPersistenceError(`${operation} did not change exactly one row`);
  }
}

function rawRow(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  try {
    return parseExactRecord(value, keys, field);
  } catch (error) {
    throw new HostStateRepositoryPersistenceError(`${field} row is invalid`, { cause: error });
  }
}

const SERVER_ROW_KEYS = [
  "collaboration_server_id",
  "machine_identity_id",
  "current_key_generation",
  "current_identity_key_id",
  "current_scope_certificate_id",
  "current_coordinator_epoch",
  "current_coordinator_lease_id",
  "next_journal_offset",
  "next_server_signature_seq",
  "next_command_seq",
  "created_at_ms",
  "state",
] as const;

function serverFromRow(value: unknown): CollaborationServerRecord {
  const row = rawRow(value, SERVER_ROW_KEYS, "collaborationServer");
  try {
    return parseCollaborationServerRecord({
      collaborationServerId: row.collaboration_server_id,
      machineIdentityId: row.machine_identity_id,
      currentKeyGeneration: row.current_key_generation,
      currentIdentityKeyId: row.current_identity_key_id,
      currentScopeCertificateId: row.current_scope_certificate_id,
      currentCoordinatorEpoch: row.current_coordinator_epoch,
      currentCoordinatorLeaseId: row.current_coordinator_lease_id,
      nextJournalOffset: row.next_journal_offset,
      nextServerSignatureSeq: row.next_server_signature_seq,
      nextCommandSeq: row.next_command_seq,
      createdAtMs: row.created_at_ms,
      state: row.state,
    });
  } catch (error) {
    throw new HostStateRepositoryPersistenceError("collaboration server row is invalid", {
      cause: error,
    });
  }
}

const PROFILE_ROW_KEYS = [
  "state_profile_id",
  "machine_identity_id",
  "default_collaboration_server_id",
  "created_at_ms",
] as const;

function profileFromRow(value: unknown): HostStateProfileRecord {
  const row = rawRow(value, PROFILE_ROW_KEYS, "hostStateProfile");
  try {
    return parseHostStateProfileRecord({
      stateProfileId: row.state_profile_id,
      machineIdentityId: row.machine_identity_id,
      defaultCollaborationServerId: row.default_collaboration_server_id,
      createdAtMs: row.created_at_ms,
    });
  } catch (error) {
    throw new HostStateRepositoryPersistenceError("host state profile row is invalid", {
      cause: error,
    });
  }
}

const PROJECT_ROW_KEYS = [
  "project_id",
  "collaboration_server_id",
  "project_allocation_intent_id",
  "project_allocation_intent_schema_id",
  "project_allocation_intent_digest",
  "allocation_kind",
  "initial_workspace_selector_id",
  "initial_target_digest",
  "initial_project_target_selector_mapping_id",
  "initial_mapping_generation",
  "initial_target_kind",
  "created_at_ms",
  "state",
] as const;

function projectFromRow(value: unknown): ProjectRecord {
  const row = rawRow(value, PROJECT_ROW_KEYS, "project");
  if (row.initial_mapping_generation !== 1 || row.initial_target_kind !== "terminal_native") {
    throw new HostStateRepositoryPersistenceError("project initial mapping proof is invalid");
  }
  try {
    const project = parseProjectRecord({
      projectId: row.project_id,
      collaborationServerId: row.collaboration_server_id,
      projectAllocationIntentId: row.project_allocation_intent_id,
      projectAllocationIntentSchemaId: row.project_allocation_intent_schema_id,
      projectAllocationIntentDigest: row.project_allocation_intent_digest,
      allocationKind: row.allocation_kind,
      initialWorkspaceSelectorId: row.initial_workspace_selector_id,
      initialTargetDigest: row.initial_target_digest,
      initialProjectTargetSelectorMappingId: row.initial_project_target_selector_mapping_id,
      createdAtMs: row.created_at_ms,
      state: row.state,
    });
    if (
      !equalDigest(
        syncProjectAllocationIntentDigest(project),
        project.projectAllocationIntentDigest,
      )
    ) {
      throw new HostStateRepositoryPersistenceError("project allocation intent digest is invalid");
    }
    return project;
  } catch (error) {
    if (error instanceof HostStateRepositoryPersistenceError) throw error;
    throw new HostStateRepositoryPersistenceError("project row is invalid", { cause: error });
  }
}

const MAPPING_ROW_KEYS = [
  "project_target_selector_mapping_id",
  "collaboration_server_id",
  "project_id",
  "workspace_selector_id",
  "target_kind",
  "target_product",
  "target_access",
  "terminal_project_ref",
  "native_workspace_binding_id",
  "nested_server_management_binding_id",
  "target_server_id",
  "target_project_id",
  "target_workspace_selector_id",
  "target_digest",
  "mapping_generation",
  "evidence_ref",
  "state",
] as const;

function mappingFromRow(value: unknown): ProjectTargetSelectorMappingRecord {
  const row = rawRow(value, MAPPING_ROW_KEYS, "projectTargetSelectorMapping");
  let target: ProjectTarget;
  if (row.target_kind === "terminal_native") {
    if (
      row.target_product === null ||
      row.target_access === null ||
      row.terminal_project_ref === null ||
      row.nested_server_management_binding_id !== null ||
      row.target_server_id !== null ||
      row.target_project_id !== null ||
      row.target_workspace_selector_id !== null
    ) {
      throw new HostStateRepositoryPersistenceError("terminal mapping target columns are invalid");
    }
    target = parseProjectTarget({
      kind: "terminal_native",
      descriptor: { product: row.target_product, access: row.target_access },
      terminalProjectRef: row.terminal_project_ref,
      nativeWorkspaceBindingId: row.native_workspace_binding_id,
    });
  } else if (row.target_kind === "nested_server") {
    if (
      row.target_product !== null ||
      row.target_access !== null ||
      row.terminal_project_ref !== null ||
      row.native_workspace_binding_id !== null ||
      row.nested_server_management_binding_id === null ||
      row.target_server_id === null ||
      row.target_project_id === null ||
      row.target_workspace_selector_id === null
    ) {
      throw new HostStateRepositoryPersistenceError("nested mapping target columns are invalid");
    }
    target = parseProjectTarget({
      kind: "nested_server",
      nestedServerManagementBindingId: row.nested_server_management_binding_id,
      targetServerId: row.target_server_id,
      targetProjectId: row.target_project_id,
      targetWorkspaceSelectorId: row.target_workspace_selector_id,
    });
  } else {
    throw new HostStateRepositoryPersistenceError("mapping target kind is invalid");
  }
  try {
    const mapping = parseProjectTargetSelectorMappingRecord({
      projectTargetSelectorMappingId: row.project_target_selector_mapping_id,
      collaborationServerId: row.collaboration_server_id,
      projectId: row.project_id,
      workspaceSelectorId: row.workspace_selector_id,
      target,
      targetDigest: row.target_digest,
      mappingGeneration: row.mapping_generation,
      evidenceRef: row.evidence_ref,
      state: row.state,
    });
    if (!equalDigest(syncProjectTargetDigest(mapping.target), mapping.targetDigest)) {
      throw new HostStateRepositoryPersistenceError("mapping target digest is invalid");
    }
    if (syncProjectTargetSelectorMappingId(mapping) !== mapping.projectTargetSelectorMappingId) {
      throw new HostStateRepositoryPersistenceError("mapping derived ID is invalid");
    }
    return mapping;
  } catch (error) {
    if (error instanceof HostStateRepositoryPersistenceError) throw error;
    throw new HostStateRepositoryPersistenceError("project target mapping row is invalid", {
      cause: error,
    });
  }
}

const CHAT_ROW_KEYS = [
  "logical_chat_id",
  "collaboration_server_id",
  "project_id",
  "project_target_selector_mapping_id",
  "state",
  "topology_generation",
  "current_inward_edge_id",
  "current_native_binding_id",
  "parent_chat_id",
  "next_viewer_projection_seq",
] as const;

function chatFromRow(value: unknown): LogicalChatRecord {
  const row = rawRow(value, CHAT_ROW_KEYS, "logicalChat");
  try {
    return parseLogicalChatRecord({
      logicalChatId: row.logical_chat_id,
      collaborationServerId: row.collaboration_server_id,
      projectId: row.project_id,
      projectTargetSelectorMappingId: row.project_target_selector_mapping_id,
      state: row.state,
      topologyGeneration: row.topology_generation,
      currentInwardEdgeId: row.current_inward_edge_id,
      currentNativeBindingId: row.current_native_binding_id,
      parentChatId: row.parent_chat_id,
      nextViewerProjectionSeq: row.next_viewer_projection_seq,
    });
  } catch (error) {
    throw new HostStateRepositoryPersistenceError("logical chat row is invalid", { cause: error });
  }
}

const BINDING_ROW_KEYS = [
  "native_binding_id",
  "collaboration_server_id",
  "logical_chat_id",
  "descriptor_product",
  "descriptor_access",
  "project_id",
  "semantic_conversation_id",
  "current_binding_incarnation_id",
  "state",
] as const;

function bindingFromRow(value: unknown): NativeBindingRecord {
  const row = rawRow(value, BINDING_ROW_KEYS, "nativeBinding");
  try {
    return parseNativeBindingRecord({
      nativeBindingId: row.native_binding_id,
      collaborationServerId: row.collaboration_server_id,
      logicalChatId: row.logical_chat_id,
      descriptor: { product: row.descriptor_product, access: row.descriptor_access },
      projectId: row.project_id,
      semanticConversationId: row.semantic_conversation_id,
      currentBindingIncarnationId: row.current_binding_incarnation_id,
      state: row.state,
    });
  } catch (error) {
    throw new HostStateRepositoryPersistenceError("native binding row is invalid", {
      cause: error,
    });
  }
}

const INTENT_ROW_KEYS = [
  "registration_attempt_id",
  "collaboration_server_id",
  "native_binding_id",
  "canonical_intent_schema_id",
  "descriptor_ref",
  "descriptor_digest",
  "project_ref",
  "project_digest",
  "expected_native_ref_digest",
  "initial_phase",
  "metadata_schema_id",
  "metadata_ref",
  "metadata_digest",
  "capabilities_ref",
  "capabilities_digest",
  "canonical_intent_digest",
  "created_at_ms",
] as const;

function intentFromRow(value: unknown): NativeRegistrationIntentRecord {
  const row = rawRow(value, INTENT_ROW_KEYS, "nativeRegistrationIntent");
  try {
    const intent = parseNativeRegistrationIntentRecord({
      registrationAttemptId: row.registration_attempt_id,
      collaborationServerId: row.collaboration_server_id,
      nativeBindingId: row.native_binding_id,
      canonicalIntentSchemaId: row.canonical_intent_schema_id,
      descriptorRef: row.descriptor_ref,
      descriptorDigest: row.descriptor_digest,
      projectRef: row.project_ref,
      projectDigest: row.project_digest,
      expectedNativeRefDigest: row.expected_native_ref_digest,
      initialPhase: row.initial_phase,
      metadataSchemaId: row.metadata_schema_id,
      metadataRef: row.metadata_ref,
      metadataDigest: row.metadata_digest,
      capabilitiesRef: row.capabilities_ref,
      capabilitiesDigest: row.capabilities_digest,
      canonicalIntentDigest: row.canonical_intent_digest,
      createdAtMs: row.created_at_ms,
    });
    if (!equalDigest(syncNativeRegistrationIntentDigest(intent), intent.canonicalIntentDigest)) {
      throw new HostStateRepositoryPersistenceError("registration intent digest is invalid");
    }
    return intent;
  } catch (error) {
    if (error instanceof HostStateRepositoryPersistenceError) throw error;
    throw new HostStateRepositoryPersistenceError("native registration intent row is invalid", {
      cause: error,
    });
  }
}

const EDGE_ROW_KEYS = [
  "inward_edge_id",
  "represented_server_id",
  "represented_logical_chat_id",
  "target_kind",
  "target_server_id",
  "target_logical_chat_id",
  "target_native_binding_id",
  "root_path_certificate_id",
  "current_connection_epoch",
  "current_live_lease_id",
  "current_capability_snapshot_id",
  "state",
] as const;

function edgeFromRow(value: unknown): InwardCollaborationEdgeRecord {
  const row = rawRow(value, EDGE_ROW_KEYS, "inwardCollaborationEdge");
  try {
    return parseInwardCollaborationEdgeRecord({
      inwardEdgeId: row.inward_edge_id,
      representedServerId: row.represented_server_id,
      representedLogicalChatId: row.represented_logical_chat_id,
      targetKind: row.target_kind,
      targetServerId: row.target_server_id,
      targetLogicalChatId: row.target_logical_chat_id,
      targetNativeBindingId: row.target_native_binding_id,
      rootPathCertificateId: row.root_path_certificate_id,
      currentConnectionEpoch: row.current_connection_epoch,
      currentLiveLeaseId: row.current_live_lease_id,
      currentCapabilitySnapshotId: row.current_capability_snapshot_id,
      state: row.state,
    });
  } catch (error) {
    throw new HostStateRepositoryPersistenceError("inward edge row is invalid", { cause: error });
  }
}

const LEASE_ROW_KEYS = [
  "coordinator_lease_id",
  "collaboration_server_id",
  "coordinator_epoch",
  "owner_instance_id",
  "acquired_at_ms",
  "initial_heartbeat_deadline_ms",
  "heartbeat_deadline_ms",
  "released_at_ms",
  "state",
] as const;

interface StoredCoordinatorLeaseRow {
  readonly lease: CoordinatorLeaseRecord;
  readonly initialHeartbeatDeadlineMs: number;
}

function storedLeaseFromRow(value: unknown): StoredCoordinatorLeaseRow {
  const row = rawRow(value, LEASE_ROW_KEYS, "coordinatorLease");
  try {
    const lease = parseCoordinatorLeaseRecord({
      coordinatorLeaseId: row.coordinator_lease_id,
      collaborationServerId: row.collaboration_server_id,
      coordinatorEpoch: row.coordinator_epoch,
      ownerInstanceId: row.owner_instance_id,
      acquiredAtMs: row.acquired_at_ms,
      heartbeatDeadlineMs: row.heartbeat_deadline_ms,
      releasedAtMs: row.released_at_ms,
      state: row.state,
    });
    if (lease.state !== "current" && lease.state !== "released") {
      throw new HostStateRepositoryPersistenceError("schema-v3 coordinator lease state is invalid");
    }
    const initialHeartbeatDeadlineMs = parsePositiveSafeInteger(
      row.initial_heartbeat_deadline_ms,
      "coordinatorLease.initialHeartbeatDeadlineMs",
    );
    if (
      initialHeartbeatDeadlineMs <= lease.acquiredAtMs ||
      initialHeartbeatDeadlineMs > lease.heartbeatDeadlineMs
    ) {
      throw new HostStateRepositoryPersistenceError(
        "coordinator lease initial heartbeat deadline is invalid",
      );
    }
    return frozen({ lease, initialHeartbeatDeadlineMs });
  } catch (error) {
    if (error instanceof HostStateRepositoryPersistenceError) throw error;
    throw new HostStateRepositoryPersistenceError("coordinator lease row is invalid", {
      cause: error,
    });
  }
}

function leaseFromRow(value: unknown): CoordinatorLeaseRecord {
  return storedLeaseFromRow(value).lease;
}

const JOURNAL_ROW_KEYS = [
  "collaboration_server_id",
  "journal_offset",
  "scope_kind",
  "logical_chat_id",
  "entry_kind",
  "subject_kind",
  "subject_id",
  "entry_schema_id",
  "entry_digest",
  "coordinator_lease_id",
  "coordinator_epoch",
  "committed_at_ms",
] as const;

function journalFromRow(value: unknown): HostStateJournalEntry {
  const row = rawRow(value, JOURNAL_ROW_KEYS, "controlJournalEntry");
  try {
    const entryKind = parseEnum(
      row.entry_kind,
      [
        "project_bootstrapped",
        "terminal_chat_reserved",
        "project_target_mapping_replaced",
        "coordinator_lease_acquired",
        "coordinator_lease_released",
      ] as const,
      "controlJournalEntry.entryKind",
    );
    const scope = parseHostStateActorScope({
      collaborationServerId: row.collaboration_server_id,
      scopeKind: row.scope_kind,
      logicalChatId: row.logical_chat_id,
    });
    const withoutDigest = frozen({
      ...scope,
      journalOffset: parseNonNegativeSafeInteger(
        row.journal_offset,
        "controlJournalEntry.journalOffset",
      ),
      entryKind,
      subjectKind: parseEnum(
        row.subject_kind,
        ["project", "logical_chat", "project_target_mapping", "coordinator_lease"] as const,
        "controlJournalEntry.subjectKind",
      ),
      subjectId: parseA1SafeId(row.subject_id, "controlJournalEntry.subjectId"),
      entrySchemaId: parseLiteral(
        row.entry_schema_id,
        HOST_STATE_JOURNAL_SCHEMA_IDS[entryKind],
        "controlJournalEntry.entrySchemaId",
      ),
      coordinatorLeaseId: parseA1CanonicalId(
        "coordinatorLease",
        row.coordinator_lease_id,
        "controlJournalEntry.coordinatorLeaseId",
      ),
      coordinatorEpoch: parsePositiveSafeInteger(
        row.coordinator_epoch,
        "controlJournalEntry.coordinatorEpoch",
      ),
      committedAtMs: parseNonNegativeSafeInteger(
        row.committed_at_ms,
        "controlJournalEntry.committedAtMs",
      ),
    }) as Omit<HostStateJournalEntry, "entryDigest">;
    const entryDigest = parseA1Digest(row.entry_digest, "controlJournalEntry.entryDigest");
    if (!equalDigest(syncHostStateJournalEntryDigest(withoutDigest), entryDigest)) {
      throw new HostStateRepositoryPersistenceError("control journal entry digest is invalid");
    }
    return frozen({ ...withoutDigest, entryDigest });
  } catch (error) {
    if (error instanceof HostStateRepositoryPersistenceError) throw error;
    throw new HostStateRepositoryPersistenceError("control journal entry row is invalid", {
      cause: error,
    });
  }
}

const selectColumns = (keys: readonly string[]): string => keys.join(", ");

const SELECT_SERVER = `SELECT ${selectColumns(SERVER_ROW_KEYS)} FROM collaboration_servers
WHERE collaboration_server_id = ? LIMIT 1`;
const SELECT_PROFILE = `SELECT ${selectColumns(PROFILE_ROW_KEYS)} FROM host_state_profiles
WHERE state_profile_id = 'default' LIMIT 1`;
const SELECT_PROJECT = `SELECT ${selectColumns(PROJECT_ROW_KEYS)} FROM projects
WHERE collaboration_server_id = ? AND project_id = ? LIMIT 1`;
const SELECT_PROJECT_BY_INTENT = `SELECT ${selectColumns(PROJECT_ROW_KEYS)} FROM projects
WHERE collaboration_server_id = ? AND project_allocation_intent_id = ? LIMIT 1`;
const SELECT_ANY_PROJECT = `SELECT ${selectColumns(PROJECT_ROW_KEYS)} FROM projects
WHERE collaboration_server_id = ? ORDER BY project_id LIMIT 1`;
const SELECT_FIRST_PROJECT = `SELECT ${selectColumns(PROJECT_ROW_KEYS)} FROM projects
WHERE collaboration_server_id = ? AND allocation_kind = 'first_bootstrap' LIMIT 1`;
const SELECT_MAPPING = `SELECT ${selectColumns(MAPPING_ROW_KEYS)}
FROM project_target_selector_mappings
WHERE collaboration_server_id = ? AND project_target_selector_mapping_id = ? LIMIT 1`;
const SELECT_MAPPING_BY_GENERATION = `SELECT ${selectColumns(MAPPING_ROW_KEYS)}
FROM project_target_selector_mappings
WHERE collaboration_server_id = ? AND project_id = ? AND workspace_selector_id = ?
  AND mapping_generation = ? LIMIT 1`;
const SELECT_CHAT = `SELECT ${selectColumns(CHAT_ROW_KEYS)} FROM logical_chats
WHERE collaboration_server_id = ? AND logical_chat_id = ? LIMIT 1`;
const SELECT_BINDING = `SELECT ${selectColumns(BINDING_ROW_KEYS)} FROM native_bindings
WHERE collaboration_server_id = ? AND native_binding_id = ? LIMIT 1`;
const SELECT_INTENT = `SELECT ${selectColumns(INTENT_ROW_KEYS)} FROM native_registration_intents
WHERE collaboration_server_id = ? AND registration_attempt_id = ? LIMIT 1`;
const SELECT_EDGE = `SELECT ${selectColumns(EDGE_ROW_KEYS)} FROM inward_collaboration_edges
WHERE represented_server_id = ? AND inward_edge_id = ? LIMIT 1`;
const SELECT_LEASE = `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM coordinator_leases
WHERE collaboration_server_id = ? AND coordinator_lease_id = ? LIMIT 1`;
const SELECT_LEASE_BY_EPOCH = `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM coordinator_leases
WHERE collaboration_server_id = ? AND coordinator_epoch = ? LIMIT 1`;
const SELECT_JOURNAL_BY_SUBJECT = `SELECT ${selectColumns(JOURNAL_ROW_KEYS)}
FROM control_journal_entries
WHERE collaboration_server_id = ? AND entry_kind = ? AND subject_id = ? LIMIT 1`;

function findServer(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
): CollaborationServerRecord | null {
  const row = sqlGet(transaction, SELECT_SERVER, [serverId]);
  return row === undefined ? null : serverFromRow(row);
}

function requireServer(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
): CollaborationServerRecord {
  const server = findServer(transaction, serverId);
  if (server === null)
    throw new HostStateRepositoryConflictError("collaboration server is unknown");
  return server;
}

function findProject(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  projectId: ProjectId,
): ProjectRecord | null {
  const row = sqlGet(transaction, SELECT_PROJECT, [serverId, projectId]);
  return row === undefined ? null : projectFromRow(row);
}

function findMapping(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  mappingId: ProjectTargetSelectorMappingId,
): ProjectTargetSelectorMappingRecord | null {
  const row = sqlGet(transaction, SELECT_MAPPING, [serverId, mappingId]);
  return row === undefined ? null : mappingFromRow(row);
}

function findMappingByGeneration(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  projectId: ProjectId,
  workspaceSelectorId: A1SafeId,
  mappingGeneration: number,
): ProjectTargetSelectorMappingRecord | null {
  const row = sqlGet(transaction, SELECT_MAPPING_BY_GENERATION, [
    serverId,
    projectId,
    workspaceSelectorId,
    mappingGeneration,
  ]);
  return row === undefined ? null : mappingFromRow(row);
}

function findChat(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  chatId: LogicalChatId,
): LogicalChatRecord | null {
  const row = sqlGet(transaction, SELECT_CHAT, [serverId, chatId]);
  return row === undefined ? null : chatFromRow(row);
}

function findBinding(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  bindingId: NativeBindingId,
): NativeBindingRecord | null {
  const row = sqlGet(transaction, SELECT_BINDING, [serverId, bindingId]);
  return row === undefined ? null : bindingFromRow(row);
}

function findGlobalRegistrationIntent(
  transaction: HostStateRepositorySqlTransaction,
  registrationAttemptId: RegistrationAttemptId,
): NativeRegistrationIntentRecord | null {
  const row = sqlGet(
    transaction,
    `SELECT ${selectColumns(INTENT_ROW_KEYS)} FROM native_registration_intents
     WHERE registration_attempt_id = ? LIMIT 1`,
    [registrationAttemptId],
  );
  return row === undefined ? null : intentFromRow(row);
}

function findEdge(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  edgeId: InwardEdgeId,
): InwardCollaborationEdgeRecord | null {
  const row = sqlGet(transaction, SELECT_EDGE, [serverId, edgeId]);
  return row === undefined ? null : edgeFromRow(row);
}

function findLease(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  leaseId: CoordinatorLeaseId,
): CoordinatorLeaseRecord | null {
  const row = sqlGet(transaction, SELECT_LEASE, [serverId, leaseId]);
  return row === undefined ? null : leaseFromRow(row);
}

function findJournalBySubject(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  entryKind: HostStateJournalEntryKind,
  subjectId: A1SafeId,
): HostStateJournalEntry | null {
  const row = sqlGet(transaction, SELECT_JOURNAL_BY_SUBJECT, [serverId, entryKind, subjectId]);
  return row === undefined ? null : journalFromRow(row);
}

function sameDescriptor(left: NativeEngineDescriptor, right: NativeEngineDescriptor): boolean {
  return left.product === right.product && left.access === right.access;
}

function sameTerminalTarget(
  left: Extract<ProjectTarget, { readonly kind: "terminal_native" }>,
  right: Extract<ProjectTarget, { readonly kind: "terminal_native" }>,
): boolean {
  return (
    sameDescriptor(left.descriptor, right.descriptor) &&
    left.terminalProjectRef === right.terminalProjectRef &&
    left.nativeWorkspaceBindingId === right.nativeWorkspaceBindingId
  );
}

function sameRegistrationInput(
  input: TerminalRegistrationInput,
  intent: NativeRegistrationIntentRecord,
  binding: NativeBindingRecord,
): boolean {
  return (
    input.registrationAttemptId === intent.registrationAttemptId &&
    sameDescriptor(input.descriptor, binding.descriptor) &&
    input.descriptorRef === intent.descriptorRef &&
    equalDigest(input.descriptorDigest, intent.descriptorDigest) &&
    input.projectRef === intent.projectRef &&
    equalDigest(input.projectDigest, intent.projectDigest) &&
    input.expectedNativeRefDigest === intent.expectedNativeRefDigest &&
    input.initialPhase === intent.initialPhase &&
    input.metadataSchemaId === intent.metadataSchemaId &&
    input.metadataRef === intent.metadataRef &&
    equalDigest(input.metadataDigest, intent.metadataDigest) &&
    input.capabilitiesRef === intent.capabilitiesRef &&
    input.capabilitiesDigest === intent.capabilitiesDigest
  );
}

function requireExactJournalLink(
  entry: HostStateJournalEntry,
  expected: Readonly<{
    entryKind: HostStateJournalEntryKind;
    subjectKind: HostStateJournalSubjectKind;
    subjectId: A1SafeId;
    scopeKind: "server_control" | "chat";
    logicalChatId: LogicalChatId | null;
  }>,
): void {
  if (
    entry.entryKind !== expected.entryKind ||
    entry.subjectKind !== expected.subjectKind ||
    entry.subjectId !== expected.subjectId ||
    entry.scopeKind !== expected.scopeKind ||
    entry.logicalChatId !== expected.logicalChatId
  ) {
    throw new HostStateRepositoryPersistenceError("journal entry linkage is invalid");
  }
}

function validateJournalFence(
  transaction: HostStateRepositorySqlTransaction,
  entry: HostStateJournalEntry,
): void {
  const lease = findLease(transaction, entry.collaborationServerId, entry.coordinatorLeaseId);
  if (
    lease === null ||
    lease.coordinatorEpoch !== entry.coordinatorEpoch ||
    entry.committedAtMs < lease.acquiredAtMs ||
    entry.committedAtMs >= lease.heartbeatDeadlineMs
  ) {
    throw new HostStateRepositoryPersistenceError("journal coordinator fence is invalid");
  }
}

interface ParsedReservationGraph {
  readonly project: ProjectRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
  readonly chat: LogicalChatRecord;
  readonly binding: NativeBindingRecord;
  readonly registrationIntent: NativeRegistrationIntentRecord;
  readonly edge: InwardCollaborationEdgeRecord;
  readonly journalEntry: HostStateJournalEntry;
}

function loadTerminalReservation(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  registrationAttemptId: RegistrationAttemptId,
  allowActivatedBinding = true,
): ParsedReservationGraph | null {
  const intentRow = sqlGet(transaction, SELECT_INTENT, [serverId, registrationAttemptId]);
  if (intentRow === undefined) return null;
  const registrationIntent = intentFromRow(intentRow);
  const binding = findBinding(transaction, serverId, registrationIntent.nativeBindingId);
  if (binding === null) {
    throw new HostStateRepositoryPersistenceError("registration intent has no native binding");
  }
  const chat = findChat(transaction, serverId, binding.logicalChatId);
  if (chat === null) {
    throw new HostStateRepositoryPersistenceError("native binding has no logical chat");
  }
  const project = findProject(transaction, serverId, chat.projectId);
  if (project === null)
    throw new HostStateRepositoryPersistenceError("logical chat has no project");
  const mapping = findMapping(transaction, serverId, chat.projectTargetSelectorMappingId);
  if (mapping === null) {
    throw new HostStateRepositoryPersistenceError("logical chat has no selector mapping");
  }
  if (chat.currentInwardEdgeId === null || chat.currentNativeBindingId === null) {
    throw new HostStateRepositoryPersistenceError(
      "terminal reservation chat has incomplete pointers",
    );
  }
  const edge = findEdge(transaction, serverId, chat.currentInwardEdgeId);
  if (edge === null)
    throw new HostStateRepositoryPersistenceError("logical chat has no inward edge");
  const bindingIsDormant =
    binding.state === "starting" &&
    binding.semanticConversationId === null &&
    binding.currentBindingIncarnationId === null;
  const bindingIsActivated =
    allowActivatedBinding &&
    binding.state === "current" &&
    binding.semanticConversationId !== null &&
    binding.currentBindingIncarnationId !== null;
  if (
    binding.collaborationServerId !== serverId ||
    binding.logicalChatId !== chat.logicalChatId ||
    binding.projectId !== project.projectId ||
    (!bindingIsDormant && !bindingIsActivated) ||
    chat.currentNativeBindingId !== binding.nativeBindingId ||
    chat.state !== "recovering" ||
    chat.nextViewerProjectionSeq !== 0 ||
    mapping.collaborationServerId !== serverId ||
    mapping.projectId !== project.projectId ||
    project.state !== "current" ||
    (mapping.state !== "current" && mapping.state !== "superseded") ||
    edge.representedServerId !== serverId ||
    edge.representedLogicalChatId !== chat.logicalChatId ||
    edge.targetKind !== "native-harness" ||
    edge.targetNativeBindingId !== binding.nativeBindingId ||
    edge.targetServerId !== null ||
    edge.targetLogicalChatId !== null ||
    edge.rootPathCertificateId !== null ||
    edge.currentConnectionEpoch !== 0 ||
    edge.currentLiveLeaseId !== null ||
    edge.currentCapabilitySnapshotId !== null ||
    edge.state !== "installing" ||
    chat.topologyGeneration !== 1 ||
    mapping.target.kind !== "terminal_native" ||
    !sameDescriptor(binding.descriptor, mapping.target.descriptor)
  ) {
    throw new HostStateRepositoryPersistenceError("terminal reservation graph linkage is invalid");
  }
  const firstBootstrap =
    project.allocationKind === "first_bootstrap" &&
    project.projectAllocationIntentId === registrationAttemptId;
  const entryKind = firstBootstrap ? "project_bootstrapped" : "terminal_chat_reserved";
  const subjectKind = firstBootstrap ? "project" : "logical_chat";
  const subjectId = firstBootstrap ? project.projectId : chat.logicalChatId;
  const journalEntry = findJournalBySubject(transaction, serverId, entryKind, subjectId);
  if (journalEntry === null) {
    throw new HostStateRepositoryPersistenceError("terminal reservation has no journal entry");
  }
  requireExactJournalLink(journalEntry, {
    entryKind,
    subjectKind,
    subjectId,
    scopeKind: "server_control",
    logicalChatId: null,
  });
  validateJournalFence(transaction, journalEntry);
  if (
    journalEntry.committedAtMs !== registrationIntent.createdAtMs ||
    (firstBootstrap && project.createdAtMs !== registrationIntent.createdAtMs)
  ) {
    throw new HostStateRepositoryPersistenceError(
      "terminal reservation commit timestamp linkage is invalid",
    );
  }
  return frozen({ project, mapping, chat, binding, registrationIntent, edge, journalEntry });
}

const FIRST_REQUEST_KEYS = [
  "fence",
  "workspaceSelectorId",
  "terminalTarget",
  "mappingEvidenceRef",
  "registration",
] as const;
const ADDITIONAL_REQUEST_KEYS = ["fence", "mappingFence", "parentChatId", "registration"] as const;
const EXPLICIT_PROJECT_REQUEST_KEYS = [
  "fence",
  "projectAllocationIntentId",
  "workspaceSelectorId",
  "terminalTarget",
  "mappingEvidenceRef",
] as const;
const REPLACE_MAPPING_REQUEST_KEYS = [
  "fence",
  "expectedMapping",
  "terminalTarget",
  "mappingEvidenceRef",
] as const;
const MAPPING_FENCE_KEYS = [
  "projectId",
  "workspaceSelectorId",
  "projectTargetSelectorMappingId",
  "mappingGeneration",
  "targetDigest",
] as const;

function parseTerminalTarget(
  value: unknown,
  field: string,
): Extract<ProjectTarget, { readonly kind: "terminal_native" }> {
  const target = parseProjectTarget(value, field);
  if (target.kind !== "terminal_native") {
    throw new HostStateContractError(`${field} must select a terminal native target`);
  }
  return target;
}

function parseFirstRequest(value: unknown): ReserveFirstTerminalChatRequest {
  const row = parseExactRecord(value, FIRST_REQUEST_KEYS, "reserveFirstTerminalChat");
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    workspaceSelectorId: parseA1SafeId(
      row.workspaceSelectorId,
      "reserveFirstTerminalChat.workspaceSelectorId",
    ),
    terminalTarget: parseTerminalTarget(
      row.terminalTarget,
      "reserveFirstTerminalChat.terminalTarget",
    ),
    mappingEvidenceRef: parseA1SafeId(
      row.mappingEvidenceRef,
      "reserveFirstTerminalChat.mappingEvidenceRef",
    ),
    registration: parseTerminalRegistrationInput(row.registration),
  });
}

function parseMappingFence(value: unknown): ProjectTargetMappingFence {
  const row = parseExactRecord(value, MAPPING_FENCE_KEYS, "mappingFence");
  return frozen({
    projectId: parseA1CanonicalId("project", row.projectId, "mappingFence.projectId"),
    workspaceSelectorId: parseA1SafeId(row.workspaceSelectorId, "mappingFence.workspaceSelectorId"),
    projectTargetSelectorMappingId: parseA1CanonicalId(
      "projectTargetSelectorMapping",
      row.projectTargetSelectorMappingId,
      "mappingFence.projectTargetSelectorMappingId",
    ),
    mappingGeneration: parsePositiveSafeInteger(
      row.mappingGeneration,
      "mappingFence.mappingGeneration",
    ),
    targetDigest: parseA1Digest(row.targetDigest, "mappingFence.targetDigest"),
  });
}

function parseAdditionalRequest(value: unknown): ReserveAdditionalTerminalChatRequest {
  const row = parseExactRecord(value, ADDITIONAL_REQUEST_KEYS, "reserveAdditionalTerminalChat");
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    mappingFence: parseMappingFence(row.mappingFence),
    parentChatId: parseNullable(
      row.parentChatId,
      (_value, field) => parseA1CanonicalId("logicalChat", _value, field),
      "reserveAdditionalTerminalChat.parentChatId",
    ),
    registration: parseTerminalRegistrationInput(row.registration),
  });
}

function parseExplicitProjectRequest(value: unknown): AllocateExplicitProjectRequest {
  const row = parseExactRecord(value, EXPLICIT_PROJECT_REQUEST_KEYS, "allocateExplicitProject");
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    projectAllocationIntentId: parseA1SafeId(
      row.projectAllocationIntentId,
      "allocateExplicitProject.projectAllocationIntentId",
    ),
    workspaceSelectorId: parseA1SafeId(
      row.workspaceSelectorId,
      "allocateExplicitProject.workspaceSelectorId",
    ),
    terminalTarget: parseTerminalTarget(
      row.terminalTarget,
      "allocateExplicitProject.terminalTarget",
    ),
    mappingEvidenceRef: parseA1SafeId(
      row.mappingEvidenceRef,
      "allocateExplicitProject.mappingEvidenceRef",
    ),
  });
}

function parseReplaceMappingRequest(value: unknown): ReplaceProjectTargetMappingRequest {
  const row = parseExactRecord(value, REPLACE_MAPPING_REQUEST_KEYS, "replaceProjectTargetMapping");
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    expectedMapping: parseMappingFence(row.expectedMapping),
    terminalTarget: parseTerminalTarget(
      row.terminalTarget,
      "replaceProjectTargetMapping.terminalTarget",
    ),
    mappingEvidenceRef: parseA1SafeId(
      row.mappingEvidenceRef,
      "replaceProjectTargetMapping.mappingEvidenceRef",
    ),
  });
}

interface CurrentFenceState {
  readonly server: CollaborationServerRecord;
  readonly lease: CoordinatorLeaseRecord;
  readonly nowMs: number;
}

function trustedNow(nowMs: () => number, field = "repository.nowMs"): number {
  return parseNonNegativeSafeInteger(nowMs(), field);
}

function assertCurrentFence(
  transaction: HostStateRepositorySqlTransaction,
  fence: CoordinatorLeaseFence,
  nowMs: () => number,
): CurrentFenceState {
  const now = trustedNow(nowMs);
  const server = findServer(transaction, fence.collaborationServerId);
  if (
    server === null ||
    server.state === "closed" ||
    server.currentCoordinatorLeaseId !== fence.coordinatorLeaseId ||
    server.currentCoordinatorEpoch !== fence.coordinatorEpoch
  ) {
    throw new HostStateStaleCoordinatorError();
  }
  const lease = findLease(transaction, fence.collaborationServerId, fence.coordinatorLeaseId);
  if (
    lease === null ||
    lease.coordinatorEpoch !== fence.coordinatorEpoch ||
    lease.state !== "current" ||
    lease.releasedAtMs !== null ||
    now < lease.acquiredAtMs ||
    now >= lease.heartbeatDeadlineMs
  ) {
    throw new HostStateStaleCoordinatorError();
  }
  return frozen({ server, lease, nowMs: now });
}

function checkedIncrement(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new HostStateRepositoryConflictError(`${field} is exhausted`);
  }
  return value + 1;
}

function checkedAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) {
    throw new HostStateRepositoryConflictError(`${field} exceeds the safe-integer range`);
  }
  return result;
}

function assertJournalCapacity(server: CollaborationServerRecord): void {
  if (server.nextJournalOffset >= Number.MAX_SAFE_INTEGER) {
    throw new HostStateRepositoryConflictError("control journal offset is exhausted");
  }
}

const ID_TABLES: Readonly<
  Record<
    "collaborationServer" | "project" | "logicalChat" | "nativeBinding" | "inwardEdge",
    Readonly<{ table: string; column: string; prefix: string }>
  >
> = Object.freeze({
  collaborationServer: Object.freeze({
    table: "collaboration_servers",
    column: "collaboration_server_id",
    prefix: "rcs_",
  }),
  project: Object.freeze({ table: "projects", column: "project_id", prefix: "rcpj_" }),
  logicalChat: Object.freeze({ table: "logical_chats", column: "logical_chat_id", prefix: "rcl_" }),
  nativeBinding: Object.freeze({
    table: "native_bindings",
    column: "native_binding_id",
    prefix: "rcnb_",
  }),
  inwardEdge: Object.freeze({
    table: "inward_collaboration_edges",
    column: "inward_edge_id",
    prefix: "rcie_",
  }),
});

function allocateRandomId<
  K extends "collaborationServer" | "project" | "logicalChat" | "nativeBinding" | "inwardEdge",
>(
  transaction: HostStateRepositorySqlTransaction,
  kind: K,
  randomBytes: (byteLength: number) => Uint8Array,
): ReturnType<typeof parseA1CanonicalId<K>> {
  const spec = ID_TABLES[kind];
  for (let attempt = 0; attempt < HOST_STATE_REPOSITORY_MAX_ID_ATTEMPTS; attempt++) {
    const bytes = randomBytes(16);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
      throw new HostStateContractError("repository randomBytes must return exactly 16 bytes");
    }
    const candidate = parseA1CanonicalId(kind, `${spec.prefix}${base64urlEncode(bytes)}`);
    const exists = sqlGet(
      transaction,
      `SELECT ${spec.column} FROM ${spec.table} WHERE ${spec.column} = ? LIMIT 1`,
      [candidate],
    );
    if (exists === undefined) return candidate;
  }
  throw new HostStateRepositoryPersistenceError(
    `could not allocate a unique ${kind} ID in ${HOST_STATE_REPOSITORY_MAX_ID_ATTEMPTS} attempts`,
  );
}

function buildJournalEntry(
  server: CollaborationServerRecord,
  fence: CoordinatorLeaseFence,
  committedAtMs: number,
  entryKind: HostStateJournalEntryKind,
  subjectKind: HostStateJournalSubjectKind,
  subjectId: A1SafeId,
  scope: HostStateActorScope,
): HostStateJournalEntry {
  assertJournalCapacity(server);
  if (scope.collaborationServerId !== server.collaborationServerId) {
    throw new HostStateContractError("journal scope must belong to its collaboration server");
  }
  const withoutDigest = frozen({
    ...scope,
    journalOffset: server.nextJournalOffset,
    entryKind,
    subjectKind,
    subjectId,
    entrySchemaId: HOST_STATE_JOURNAL_SCHEMA_IDS[entryKind],
    coordinatorLeaseId: fence.coordinatorLeaseId,
    coordinatorEpoch: fence.coordinatorEpoch,
    committedAtMs,
  }) as Omit<HostStateJournalEntry, "entryDigest">;
  return frozen({
    ...withoutDigest,
    entryDigest: syncHostStateJournalEntryDigest(withoutDigest),
  });
}

function insertJournalEntry(
  transaction: HostStateRepositorySqlTransaction,
  entry: HostStateJournalEntry,
): void {
  runExactlyOne(
    transaction,
    `INSERT INTO control_journal_entries (
      collaboration_server_id, journal_offset, scope_kind, logical_chat_id,
      entry_kind, subject_kind, subject_id, entry_schema_id, entry_digest,
      coordinator_lease_id, coordinator_epoch, committed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.collaborationServerId,
      entry.journalOffset,
      entry.scopeKind,
      entry.logicalChatId,
      entry.entryKind,
      entry.subjectKind,
      entry.subjectId,
      entry.entrySchemaId,
      entry.entryDigest,
      entry.coordinatorLeaseId,
      entry.coordinatorEpoch,
      entry.committedAtMs,
    ],
    "control journal insert",
  );
}

interface CreatedProjectRows {
  readonly project: ProjectRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
}

function insertProjectAndInitialMapping(
  transaction: HostStateRepositorySqlTransaction,
  value: Readonly<{
    collaborationServerId: CollaborationServerId;
    projectId: ProjectId;
    allocationKind: "first_bootstrap" | "explicit_new_project";
    projectAllocationIntentId: A1SafeId;
    workspaceSelectorId: A1SafeId;
    terminalTarget: Extract<ProjectTarget, { readonly kind: "terminal_native" }>;
    mappingEvidenceRef: A1SafeId;
    createdAtMs: number;
  }>,
): CreatedProjectRows {
  const targetDigest = syncProjectTargetDigest(value.terminalTarget);
  const mappingId = syncProjectTargetSelectorMappingId({
    collaborationServerId: value.collaborationServerId,
    projectId: value.projectId,
    workspaceSelectorId: value.workspaceSelectorId,
    mappingGeneration: 1,
    targetDigest,
  });
  if (
    sqlGet(
      transaction,
      `SELECT project_target_selector_mapping_id FROM project_target_selector_mappings
       WHERE project_target_selector_mapping_id = ? LIMIT 1`,
      [mappingId],
    ) !== undefined
  ) {
    throw new HostStateRepositoryConflictError("derived project target mapping ID is occupied");
  }
  const mapping = parseProjectTargetSelectorMappingRecord({
    projectTargetSelectorMappingId: mappingId,
    collaborationServerId: value.collaborationServerId,
    projectId: value.projectId,
    workspaceSelectorId: value.workspaceSelectorId,
    target: value.terminalTarget,
    targetDigest,
    mappingGeneration: 1,
    evidenceRef: value.mappingEvidenceRef,
    state: "current",
  });
  if (mapping.target.kind !== "terminal_native") {
    throw new HostStateRepositoryPersistenceError("new project mapping lost its terminal target");
  }
  const terminalTarget = mapping.target;
  const projectWithoutDigest = {
    projectId: value.projectId,
    collaborationServerId: value.collaborationServerId,
    projectAllocationIntentId: value.projectAllocationIntentId,
    projectAllocationIntentSchemaId: "remote-claw/project-allocation-intent/v1" as const,
    allocationKind: value.allocationKind,
    initialWorkspaceSelectorId: value.workspaceSelectorId,
    initialTargetDigest: targetDigest,
  };
  const project = parseProjectRecord({
    ...projectWithoutDigest,
    projectAllocationIntentDigest: syncProjectAllocationIntentDigest(projectWithoutDigest),
    initialProjectTargetSelectorMappingId: mappingId,
    createdAtMs: value.createdAtMs,
    state: "current",
  });
  // The schema's deferred mapping -> project FK permits this order; the
  // project INSERT trigger then proves that its exact initial mapping is current.
  runExactlyOne(
    transaction,
    `INSERT INTO project_target_selector_mappings (
      project_target_selector_mapping_id, collaboration_server_id, project_id,
      workspace_selector_id, target_kind, target_product, target_access,
      terminal_project_ref, native_workspace_binding_id,
      nested_server_management_binding_id, target_server_id, target_project_id,
      target_workspace_selector_id, target_digest, mapping_generation, evidence_ref, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    [
      mapping.projectTargetSelectorMappingId,
      mapping.collaborationServerId,
      mapping.projectId,
      mapping.workspaceSelectorId,
      terminalTarget.kind,
      terminalTarget.descriptor.product,
      terminalTarget.descriptor.access,
      terminalTarget.terminalProjectRef,
      terminalTarget.nativeWorkspaceBindingId,
      mapping.targetDigest,
      mapping.mappingGeneration,
      mapping.evidenceRef,
      mapping.state,
    ],
    "project target mapping insert",
  );
  runExactlyOne(
    transaction,
    `INSERT INTO projects (
      project_id, collaboration_server_id, project_allocation_intent_id,
      project_allocation_intent_schema_id, project_allocation_intent_digest,
      allocation_kind, initial_workspace_selector_id, initial_target_digest,
      initial_project_target_selector_mapping_id, initial_mapping_generation,
      initial_target_kind, created_at_ms, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'terminal_native', ?, ?)`,
    [
      project.projectId,
      project.collaborationServerId,
      project.projectAllocationIntentId,
      project.projectAllocationIntentSchemaId,
      project.projectAllocationIntentDigest,
      project.allocationKind,
      project.initialWorkspaceSelectorId,
      project.initialTargetDigest,
      project.initialProjectTargetSelectorMappingId,
      project.createdAtMs,
      project.state,
    ],
    "project insert",
  );
  return frozen({ project, mapping });
}

interface CreatedTerminalRows {
  readonly chat: LogicalChatRecord;
  readonly binding: NativeBindingRecord;
  readonly registrationIntent: NativeRegistrationIntentRecord;
  readonly edge: InwardCollaborationEdgeRecord;
}

function insertTerminalChatRows(
  transaction: HostStateRepositorySqlTransaction,
  randomBytes: (byteLength: number) => Uint8Array,
  value: Readonly<{
    collaborationServerId: CollaborationServerId;
    project: ProjectRecord;
    mapping: ProjectTargetSelectorMappingRecord;
    parentChatId: LogicalChatId | null;
    registration: TerminalRegistrationInput;
    createdAtMs: number;
  }>,
): CreatedTerminalRows {
  if (value.mapping.target.kind !== "terminal_native") {
    throw new HostStateRepositoryConflictError("selected mapping is not terminal native");
  }
  if (!sameDescriptor(value.mapping.target.descriptor, value.registration.descriptor)) {
    throw new HostStateRepositoryConflictError(
      "registration descriptor does not match the selected terminal mapping",
    );
  }
  const chatId = allocateRandomId(transaction, "logicalChat", randomBytes);
  const bindingId = allocateRandomId(transaction, "nativeBinding", randomBytes);
  const edgeId = allocateRandomId(transaction, "inwardEdge", randomBytes);
  const chat = parseLogicalChatRecord({
    logicalChatId: chatId,
    collaborationServerId: value.collaborationServerId,
    projectId: value.project.projectId,
    projectTargetSelectorMappingId: value.mapping.projectTargetSelectorMappingId,
    state: "recovering",
    topologyGeneration: 1,
    currentInwardEdgeId: edgeId,
    currentNativeBindingId: bindingId,
    parentChatId: value.parentChatId,
    nextViewerProjectionSeq: 0,
  });
  const binding = parseNativeBindingRecord({
    nativeBindingId: bindingId,
    collaborationServerId: value.collaborationServerId,
    logicalChatId: chatId,
    descriptor: value.registration.descriptor,
    projectId: value.project.projectId,
    semanticConversationId: null,
    currentBindingIncarnationId: null,
    state: "starting",
  });
  const intentWithoutDigest = {
    registrationAttemptId: value.registration.registrationAttemptId,
    collaborationServerId: value.collaborationServerId,
    nativeBindingId: bindingId,
    canonicalIntentSchemaId: "remote-claw/native-registration-intent/v1" as const,
    descriptorRef: value.registration.descriptorRef,
    descriptorDigest: value.registration.descriptorDigest,
    projectRef: value.registration.projectRef,
    projectDigest: value.registration.projectDigest,
    expectedNativeRefDigest: value.registration.expectedNativeRefDigest,
    initialPhase: value.registration.initialPhase,
    metadataSchemaId: value.registration.metadataSchemaId,
    metadataRef: value.registration.metadataRef,
    metadataDigest: value.registration.metadataDigest,
    capabilitiesRef: value.registration.capabilitiesRef,
    capabilitiesDigest: value.registration.capabilitiesDigest,
  };
  const registrationIntent = parseNativeRegistrationIntentRecord({
    ...intentWithoutDigest,
    canonicalIntentDigest: syncNativeRegistrationIntentDigest(intentWithoutDigest),
    createdAtMs: value.createdAtMs,
  });
  const edge = parseInwardCollaborationEdgeRecord({
    inwardEdgeId: edgeId,
    representedServerId: value.collaborationServerId,
    representedLogicalChatId: chatId,
    targetKind: "native-harness",
    targetServerId: null,
    targetLogicalChatId: null,
    targetNativeBindingId: bindingId,
    rootPathCertificateId: null,
    currentConnectionEpoch: 0,
    currentLiveLeaseId: null,
    currentCapabilitySnapshotId: null,
    state: "installing",
  });
  // All pointer FKs are deferred so the final graph, rather than an insertion
  // order artifact, is the atomic invariant.
  runExactlyOne(
    transaction,
    `INSERT INTO logical_chats (
      logical_chat_id, collaboration_server_id, project_id,
      project_target_selector_mapping_id, state, topology_generation,
      current_inward_edge_id, current_native_binding_id, parent_chat_id,
      next_viewer_projection_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chat.logicalChatId,
      chat.collaborationServerId,
      chat.projectId,
      chat.projectTargetSelectorMappingId,
      chat.state,
      chat.topologyGeneration,
      chat.currentInwardEdgeId,
      chat.currentNativeBindingId,
      chat.parentChatId,
      chat.nextViewerProjectionSeq,
    ],
    "logical chat insert",
  );
  runExactlyOne(
    transaction,
    `INSERT INTO native_bindings (
      native_binding_id, collaboration_server_id, logical_chat_id,
      descriptor_product, descriptor_access, project_id,
      semantic_conversation_id, current_binding_incarnation_id, state
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      binding.nativeBindingId,
      binding.collaborationServerId,
      binding.logicalChatId,
      binding.descriptor.product,
      binding.descriptor.access,
      binding.projectId,
      binding.state,
    ],
    "native binding insert",
  );
  runExactlyOne(
    transaction,
    `INSERT INTO native_registration_intents (
      registration_attempt_id, collaboration_server_id, native_binding_id,
      canonical_intent_schema_id, descriptor_ref, descriptor_digest,
      project_ref, project_digest, expected_native_ref_digest, initial_phase,
      metadata_schema_id, metadata_ref, metadata_digest, capabilities_ref,
      capabilities_digest, canonical_intent_digest, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      registrationIntent.registrationAttemptId,
      registrationIntent.collaborationServerId,
      registrationIntent.nativeBindingId,
      registrationIntent.canonicalIntentSchemaId,
      registrationIntent.descriptorRef,
      registrationIntent.descriptorDigest,
      registrationIntent.projectRef,
      registrationIntent.projectDigest,
      registrationIntent.expectedNativeRefDigest,
      registrationIntent.initialPhase,
      registrationIntent.metadataSchemaId,
      registrationIntent.metadataRef,
      registrationIntent.metadataDigest,
      registrationIntent.capabilitiesRef,
      registrationIntent.capabilitiesDigest,
      registrationIntent.canonicalIntentDigest,
      registrationIntent.createdAtMs,
    ],
    "native registration intent insert",
  );
  runExactlyOne(
    transaction,
    `INSERT INTO inward_collaboration_edges (
      inward_edge_id, represented_server_id, represented_logical_chat_id,
      target_kind, target_server_id, target_logical_chat_id,
      target_native_binding_id, root_path_certificate_id,
      current_connection_epoch, current_live_lease_id,
      current_capability_snapshot_id, state
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 0, NULL, NULL, ?)`,
    [
      edge.inwardEdgeId,
      edge.representedServerId,
      edge.representedLogicalChatId,
      edge.targetKind,
      edge.targetNativeBindingId,
      edge.state,
    ],
    "inward edge insert",
  );
  return frozen({ chat, binding, registrationIntent, edge });
}

interface ParsedProjectAllocation {
  readonly project: ProjectRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
  readonly journalEntry: HostStateJournalEntry;
}

function loadProjectAllocation(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  intentId: A1SafeId,
): ParsedProjectAllocation | null {
  const row = sqlGet(transaction, SELECT_PROJECT_BY_INTENT, [serverId, intentId]);
  if (row === undefined) return null;
  const project = projectFromRow(row);
  const mapping = findMapping(transaction, serverId, project.initialProjectTargetSelectorMappingId);
  if (
    mapping === null ||
    mapping.projectId !== project.projectId ||
    mapping.workspaceSelectorId !== project.initialWorkspaceSelectorId ||
    !equalDigest(mapping.targetDigest, project.initialTargetDigest) ||
    mapping.mappingGeneration !== 1 ||
    mapping.target.kind !== "terminal_native"
  ) {
    throw new HostStateRepositoryPersistenceError("project initial mapping linkage is invalid");
  }
  const journalEntry = findJournalBySubject(
    transaction,
    serverId,
    "project_bootstrapped",
    project.projectId,
  );
  if (journalEntry === null) {
    throw new HostStateRepositoryPersistenceError("project allocation has no journal entry");
  }
  requireExactJournalLink(journalEntry, {
    entryKind: "project_bootstrapped",
    subjectKind: "project",
    subjectId: project.projectId,
    scopeKind: "server_control",
    logicalChatId: null,
  });
  validateJournalFence(transaction, journalEntry);
  if (journalEntry.committedAtMs !== project.createdAtMs) {
    throw new HostStateRepositoryPersistenceError(
      "project allocation commit timestamp linkage is invalid",
    );
  }
  if (project.allocationKind === "first_bootstrap") {
    let registrationAttemptId: RegistrationAttemptId;
    try {
      registrationAttemptId = parseA1CanonicalId(
        "registrationAttempt",
        project.projectAllocationIntentId,
        "project.projectAllocationIntentId",
      );
    } catch (error) {
      throw new HostStateRepositoryPersistenceError(
        "first-bootstrap allocation intent is not a registration attempt",
        { cause: error },
      );
    }
    const reservation = loadTerminalReservation(transaction, serverId, registrationAttemptId);
    if (
      reservation === null ||
      reservation.project.projectId !== project.projectId ||
      reservation.journalEntry.entryKind !== "project_bootstrapped" ||
      reservation.journalEntry.subjectId !== project.projectId
    ) {
      throw new HostStateRepositoryPersistenceError(
        "first-bootstrap project terminal graph is incomplete",
      );
    }
  }
  return frozen({ project, mapping, journalEntry });
}

function projectAllocationMatches(
  allocation: ParsedProjectAllocation,
  allocationKind: "first_bootstrap" | "explicit_new_project",
  intentId: A1SafeId,
  workspaceSelectorId: A1SafeId,
  target: Extract<ProjectTarget, { readonly kind: "terminal_native" }>,
  evidenceRef: A1SafeId,
): boolean {
  return (
    allocation.project.allocationKind === allocationKind &&
    allocation.project.projectAllocationIntentId === intentId &&
    allocation.project.initialWorkspaceSelectorId === workspaceSelectorId &&
    allocation.mapping.workspaceSelectorId === workspaceSelectorId &&
    allocation.mapping.target.kind === "terminal_native" &&
    sameTerminalTarget(allocation.mapping.target, target) &&
    allocation.mapping.evidenceRef === evidenceRef
  );
}

interface ParsedMappingReplacement {
  readonly project: ProjectRecord;
  readonly previousMapping: ProjectTargetSelectorMappingRecord;
  readonly mapping: ProjectTargetSelectorMappingRecord;
  readonly journalEntry: HostStateJournalEntry;
}

function loadMappingReplacement(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  mappingId: ProjectTargetSelectorMappingId,
): ParsedMappingReplacement | null {
  const mapping = findMapping(transaction, serverId, mappingId);
  if (mapping === null) return null;
  if (mapping.mappingGeneration <= 1 || mapping.target.kind !== "terminal_native") {
    throw new HostStateRepositoryPersistenceError(
      "mapping replacement does not name a later terminal generation",
    );
  }
  const project = findProject(transaction, serverId, mapping.projectId);
  const previousMapping = findMappingByGeneration(
    transaction,
    serverId,
    mapping.projectId,
    mapping.workspaceSelectorId,
    mapping.mappingGeneration - 1,
  );
  if (
    project === null ||
    project.state !== "current" ||
    previousMapping === null ||
    previousMapping.state !== "superseded" ||
    previousMapping.target.kind !== "terminal_native" ||
    (mapping.state !== "current" && mapping.state !== "superseded")
  ) {
    throw new HostStateRepositoryPersistenceError("mapping replacement linkage is invalid");
  }
  const journalEntry = findJournalBySubject(
    transaction,
    serverId,
    "project_target_mapping_replaced",
    mappingId,
  );
  if (journalEntry === null) {
    throw new HostStateRepositoryPersistenceError("mapping replacement has no journal entry");
  }
  requireExactJournalLink(journalEntry, {
    entryKind: "project_target_mapping_replaced",
    subjectKind: "project_target_mapping",
    subjectId: mappingId,
    scopeKind: "server_control",
    logicalChatId: null,
  });
  validateJournalFence(transaction, journalEntry);
  return frozen({ project, previousMapping, mapping, journalEntry });
}

function loadValidatedMappingChain(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  projectId: ProjectId,
  workspaceSelectorId: A1SafeId,
): readonly ProjectTargetSelectorMappingRecord[] {
  const project = findProject(transaction, serverId, projectId);
  if (project === null) return Object.freeze([]);
  if (project.state !== "current") {
    throw new HostStateRepositoryPersistenceError("mapping chain project is not current");
  }
  const mappings = sqlAll(
    transaction,
    `SELECT ${selectColumns(MAPPING_ROW_KEYS)} FROM project_target_selector_mappings
     WHERE collaboration_server_id = ? AND project_id = ? AND workspace_selector_id = ?
     ORDER BY mapping_generation`,
    [serverId, projectId, workspaceSelectorId],
  ).map(mappingFromRow);
  if (mappings.length === 0) return Object.freeze([]);
  if (
    project.initialWorkspaceSelectorId !== workspaceSelectorId ||
    mappings[0]?.projectTargetSelectorMappingId !== project.initialProjectTargetSelectorMappingId
  ) {
    throw new HostStateRepositoryPersistenceError(
      "mapping chain is not the project's initial selector chain",
    );
  }
  for (let index = 0; index < mappings.length; index++) {
    const mapping = mappings[index];
    if (
      mapping === undefined ||
      mapping.mappingGeneration !== index + 1 ||
      mapping.target.kind !== "terminal_native" ||
      (index === mappings.length - 1 ? mapping.state !== "current" : mapping.state !== "superseded")
    ) {
      throw new HostStateRepositoryPersistenceError(
        "mapping chain is not contiguous with one current terminal tail",
      );
    }
    if (mapping.mappingGeneration > 1) {
      const replacement = loadMappingReplacement(
        transaction,
        serverId,
        mapping.projectTargetSelectorMappingId,
      );
      if (
        replacement === null ||
        replacement.previousMapping.projectTargetSelectorMappingId !==
          mappings[index - 1]?.projectTargetSelectorMappingId
      ) {
        throw new HostStateRepositoryPersistenceError(
          "mapping chain replacement evidence is incomplete",
        );
      }
    }
  }
  return Object.freeze(mappings);
}

interface ParsedLeaseAcquisition {
  readonly lease: CoordinatorLeaseRecord;
  readonly journalEntry: HostStateJournalEntry;
  readonly releaseJournalEntry: HostStateJournalEntry | null;
}

function loadLeaseAcquisition(
  transaction: HostStateRepositorySqlTransaction,
  serverId: CollaborationServerId,
  leaseId: CoordinatorLeaseId,
): ParsedLeaseAcquisition | null {
  const lease = findLease(transaction, serverId, leaseId);
  if (lease === null) return null;
  const journalEntry = findJournalBySubject(
    transaction,
    serverId,
    "coordinator_lease_acquired",
    leaseId,
  );
  if (journalEntry === null) {
    throw new HostStateRepositoryPersistenceError(
      "coordinator lease has no acquisition journal entry",
    );
  }
  requireExactJournalLink(journalEntry, {
    entryKind: "coordinator_lease_acquired",
    subjectKind: "coordinator_lease",
    subjectId: leaseId,
    scopeKind: "server_control",
    logicalChatId: null,
  });
  validateJournalFence(transaction, journalEntry);
  if (
    journalEntry.coordinatorEpoch !== lease.coordinatorEpoch ||
    journalEntry.coordinatorLeaseId !== lease.coordinatorLeaseId ||
    journalEntry.committedAtMs !== lease.acquiredAtMs
  ) {
    throw new HostStateRepositoryPersistenceError(
      "coordinator acquisition journal linkage is invalid",
    );
  }
  const releaseJournalEntry = findJournalBySubject(
    transaction,
    serverId,
    "coordinator_lease_released",
    leaseId,
  );
  if (lease.state === "released") {
    if (
      releaseJournalEntry === null ||
      lease.releasedAtMs === null ||
      releaseJournalEntry.coordinatorLeaseId !== leaseId ||
      releaseJournalEntry.coordinatorEpoch !== lease.coordinatorEpoch ||
      releaseJournalEntry.committedAtMs !== lease.releasedAtMs
    ) {
      throw new HostStateRepositoryPersistenceError(
        "coordinator release journal linkage is invalid",
      );
    }
    requireExactJournalLink(releaseJournalEntry, {
      entryKind: "coordinator_lease_released",
      subjectKind: "coordinator_lease",
      subjectId: leaseId,
      scopeKind: "server_control",
      logicalChatId: null,
    });
    validateJournalFence(transaction, releaseJournalEntry);
  } else if (releaseJournalEntry !== null) {
    throw new HostStateRepositoryPersistenceError(
      "unreleased coordinator lease has a release journal entry",
    );
  }
  return frozen({ lease, journalEntry, releaseJournalEntry });
}

function reservationResult(
  graph: ParsedReservationGraph,
  replayed: boolean,
): TerminalChatReservationResult {
  return frozen({ ...graph, replayed });
}

const ACQUIRE_KEYS = [
  "collaborationServerId",
  "candidateLeaseId",
  "ownerInstanceId",
  "expectedCurrentLeaseId",
  "expectedCoordinatorEpoch",
  "leaseDurationMs",
] as const;
const RENEW_KEYS = ["fence", "expectedHeartbeatDeadlineMs", "newHeartbeatDeadlineMs"] as const;
const RELEASE_KEYS = ["fence"] as const;

function parseAcquireRequest(value: unknown): AcquireCoordinatorLeaseRequest {
  const row = parseExactRecord(value, ACQUIRE_KEYS, "acquireCoordinatorLease");
  return frozen({
    collaborationServerId: parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "acquireCoordinatorLease.collaborationServerId",
    ),
    candidateLeaseId: parseA1CanonicalId(
      "coordinatorLease",
      row.candidateLeaseId,
      "acquireCoordinatorLease.candidateLeaseId",
    ),
    ownerInstanceId: parseA1SafeId(row.ownerInstanceId, "acquireCoordinatorLease.ownerInstanceId"),
    expectedCurrentLeaseId: parseNullable(
      row.expectedCurrentLeaseId,
      (_value, field) => parseA1CanonicalId("coordinatorLease", _value, field),
      "acquireCoordinatorLease.expectedCurrentLeaseId",
    ),
    expectedCoordinatorEpoch: parseNonNegativeSafeInteger(
      row.expectedCoordinatorEpoch,
      "acquireCoordinatorLease.expectedCoordinatorEpoch",
    ),
    leaseDurationMs: parsePositiveSafeInteger(
      row.leaseDurationMs,
      "acquireCoordinatorLease.leaseDurationMs",
    ),
  });
}

function parseRenewRequest(value: unknown): RenewCoordinatorLeaseRequest {
  const row = parseExactRecord(value, RENEW_KEYS, "renewCoordinatorLease");
  const expectedHeartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.expectedHeartbeatDeadlineMs,
    "renewCoordinatorLease.expectedHeartbeatDeadlineMs",
  );
  const newHeartbeatDeadlineMs = parseNonNegativeSafeInteger(
    row.newHeartbeatDeadlineMs,
    "renewCoordinatorLease.newHeartbeatDeadlineMs",
  );
  if (newHeartbeatDeadlineMs <= expectedHeartbeatDeadlineMs) {
    throw new HostStateContractError(
      "renewCoordinatorLease.newHeartbeatDeadlineMs must strictly extend the expected deadline",
    );
  }
  return frozen({
    fence: parseCoordinatorLeaseFence(row.fence),
    expectedHeartbeatDeadlineMs,
    newHeartbeatDeadlineMs,
  });
}

function parseReleaseRequest(value: unknown): ReleaseCoordinatorLeaseRequest {
  const row = parseExactRecord(value, RELEASE_KEYS, "releaseCoordinatorLease");
  return frozen({ fence: parseCoordinatorLeaseFence(row.fence) });
}

function assertAcquisitionIntentMatches(
  transaction: HostStateRepositorySqlTransaction,
  request: AcquireCoordinatorLeaseRequest,
  storedLease: StoredCoordinatorLeaseRow,
): void {
  const { lease } = storedLease;
  const expectedEpoch = checkedIncrement(request.expectedCoordinatorEpoch, "coordinator epoch");
  if (
    lease.collaborationServerId !== request.collaborationServerId ||
    lease.coordinatorEpoch !== expectedEpoch ||
    lease.ownerInstanceId !== request.ownerInstanceId ||
    storedLease.initialHeartbeatDeadlineMs - lease.acquiredAtMs !== request.leaseDurationMs
  ) {
    throw new HostStateRepositoryConflictError("coordinator lease acquisition intent collided");
  }
  if (request.expectedCurrentLeaseId === null) {
    if (request.expectedCoordinatorEpoch === 0) return;
    const predecessorRow = sqlGet(transaction, SELECT_LEASE_BY_EPOCH, [
      request.collaborationServerId,
      request.expectedCoordinatorEpoch,
    ]);
    const predecessor = predecessorRow === undefined ? null : leaseFromRow(predecessorRow);
    if (
      predecessor === null ||
      predecessor.state !== "released" ||
      predecessor.releasedAtMs === null ||
      lease.acquiredAtMs < predecessor.releasedAtMs
    ) {
      throw new HostStateRepositoryConflictError(
        "coordinator acquisition predecessor did not have a released null pointer",
      );
    }
    return;
  }
  const predecessor = findLease(
    transaction,
    request.collaborationServerId,
    request.expectedCurrentLeaseId,
  );
  if (
    predecessor === null ||
    predecessor.coordinatorEpoch !== request.expectedCoordinatorEpoch ||
    predecessor.state !== "current" ||
    predecessor.releasedAtMs !== null ||
    predecessor.heartbeatDeadlineMs > lease.acquiredAtMs
  ) {
    throw new HostStateRepositoryConflictError(
      "coordinator acquisition predecessor does not match",
    );
  }
}

export class HostStateRepository implements HostStateRepositoryOperations {
  readonly #executor: HostStateRepositoryTransactionExecutor;
  readonly #machineIdentityId: string;
  readonly #randomBytes: (byteLength: number) => Uint8Array;
  readonly #nowMs: () => number;

  constructor(
    executor: HostStateRepositoryTransactionExecutor,
    machineIdentityId: string,
    options: HostStateRepositoryOptions = {},
  ) {
    if (
      typeof executor !== "object" ||
      executor === null ||
      typeof executor.transaction !== "function"
    ) {
      throw new HostStateContractError("host state repository executor must provide transaction");
    }
    this.#executor = executor;
    this.#machineIdentityId = parseMachineIdentityId(machineIdentityId);
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  ensureDefaultCollaborationServer(): DefaultCollaborationServerResult {
    return this.#executor.transaction((transaction) => {
      const existingRow = sqlGet(transaction, SELECT_PROFILE);
      if (existingRow !== undefined) {
        const profile = profileFromRow(existingRow);
        if (profile.machineIdentityId !== this.#machineIdentityId) {
          throw new HostStateRepositoryPersistenceError(
            "default profile machine identity does not match the database",
          );
        }
        const server = requireServer(transaction, profile.defaultCollaborationServerId);
        if (server.machineIdentityId !== this.#machineIdentityId) {
          throw new HostStateRepositoryPersistenceError(
            "default profile server machine identity does not match",
          );
        }
        if (server.state !== "installing") {
          throw new HostStateRepositoryPersistenceError(
            "schema-v3 default collaboration server is not dormant",
          );
        }
        validateServerLeasePointer(transaction, server);
        return frozen({ profile, server, created: false });
      }
      const collaborationServerId = allocateRandomId(
        transaction,
        "collaborationServer",
        this.#randomBytes,
      );
      const createdAtMs = trustedNow(this.#nowMs);
      const server = parseCollaborationServerRecord({
        collaborationServerId,
        machineIdentityId: this.#machineIdentityId,
        currentKeyGeneration: 0,
        currentIdentityKeyId: null,
        currentScopeCertificateId: null,
        currentCoordinatorEpoch: 0,
        currentCoordinatorLeaseId: null,
        nextJournalOffset: 0,
        nextServerSignatureSeq: 0,
        nextCommandSeq: 0,
        createdAtMs,
        state: "installing",
      });
      const profile = parseHostStateProfileRecord({
        stateProfileId: "default",
        machineIdentityId: this.#machineIdentityId,
        defaultCollaborationServerId: collaborationServerId,
        createdAtMs,
      });
      runExactlyOne(
        transaction,
        `INSERT INTO collaboration_servers (
          collaboration_server_id, machine_identity_id, current_key_generation,
          current_identity_key_id, current_scope_certificate_id,
          current_coordinator_epoch, current_coordinator_lease_id,
          next_journal_offset, next_server_signature_seq, next_command_seq,
          created_at_ms, state
        ) VALUES (?, ?, 0, NULL, NULL, 0, NULL, 0, 0, 0, ?, 'installing')`,
        [collaborationServerId, this.#machineIdentityId, createdAtMs],
        "collaboration server bootstrap insert",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO host_state_profiles (
          state_profile_id, machine_identity_id, default_collaboration_server_id, created_at_ms
        ) VALUES ('default', ?, ?, ?)`,
        [this.#machineIdentityId, collaborationServerId, createdAtMs],
        "default host state profile insert",
      );
      return frozen({ profile, server, created: true });
    });
  }

  allocateExplicitProject(request: AllocateExplicitProjectRequest): AllocateExplicitProjectResult {
    const parsed = parseExplicitProjectRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentFence(transaction, parsed.fence, this.#nowMs);
      const existing = loadProjectAllocation(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.projectAllocationIntentId,
      );
      if (existing !== null) {
        if (
          !projectAllocationMatches(
            existing,
            "explicit_new_project",
            parsed.projectAllocationIntentId,
            parsed.workspaceSelectorId,
            parsed.terminalTarget,
            parsed.mappingEvidenceRef,
          )
        ) {
          throw new HostStateRepositoryConflictError("project allocation intent collided");
        }
        return frozen({ ...existing, replayed: true });
      }
      assertJournalCapacity(current.server);
      if (
        sqlGet(transaction, SELECT_FIRST_PROJECT, [parsed.fence.collaborationServerId]) ===
        undefined
      ) {
        throw new HostStateRepositoryConflictError(
          "explicit project allocation requires an existing first-bootstrap project",
        );
      }
      const projectId = allocateRandomId(transaction, "project", this.#randomBytes);
      const created = insertProjectAndInitialMapping(transaction, {
        collaborationServerId: parsed.fence.collaborationServerId,
        projectId,
        allocationKind: "explicit_new_project",
        projectAllocationIntentId: parsed.projectAllocationIntentId,
        workspaceSelectorId: parsed.workspaceSelectorId,
        terminalTarget: parsed.terminalTarget,
        mappingEvidenceRef: parsed.mappingEvidenceRef,
        createdAtMs: current.nowMs,
      });
      const journalEntry = buildJournalEntry(
        current.server,
        parsed.fence,
        current.nowMs,
        "project_bootstrapped",
        "project",
        created.project.projectId,
        {
          collaborationServerId: parsed.fence.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
        },
      );
      insertJournalEntry(transaction, journalEntry);
      return frozen({ ...created, journalEntry, replayed: false });
    });
  }

  replaceProjectTargetMapping(
    request: ReplaceProjectTargetMappingRequest,
  ): ReplaceProjectTargetMappingResult {
    const parsed = parseReplaceMappingRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentFence(transaction, parsed.fence, this.#nowMs);
      const mappingGeneration = checkedIncrement(
        parsed.expectedMapping.mappingGeneration,
        "project target mapping generation",
      );
      const targetDigest = syncProjectTargetDigest(parsed.terminalTarget);
      const mappingId = syncProjectTargetSelectorMappingId({
        collaborationServerId: parsed.fence.collaborationServerId,
        projectId: parsed.expectedMapping.projectId,
        workspaceSelectorId: parsed.expectedMapping.workspaceSelectorId,
        mappingGeneration,
        targetDigest,
      });
      const globallyExisting = sqlGet(
        transaction,
        `SELECT ${selectColumns(MAPPING_ROW_KEYS)} FROM project_target_selector_mappings
         WHERE project_target_selector_mapping_id = ? LIMIT 1`,
        [mappingId],
      );
      if (globallyExisting !== undefined) {
        const occupied = mappingFromRow(globallyExisting);
        if (occupied.collaborationServerId !== parsed.fence.collaborationServerId) {
          throw new HostStateRepositoryConflictError(
            "derived project target mapping ID is occupied by another server",
          );
        }
        if (
          occupied.projectId !== parsed.expectedMapping.projectId ||
          occupied.workspaceSelectorId !== parsed.expectedMapping.workspaceSelectorId ||
          occupied.mappingGeneration !== mappingGeneration ||
          !equalDigest(occupied.targetDigest, targetDigest)
        ) {
          throw new HostStateRepositoryConflictError(
            "derived project target mapping ID is occupied by another mapping",
          );
        }
        const existing = loadMappingReplacement(
          transaction,
          parsed.fence.collaborationServerId,
          mappingId,
        );
        if (
          existing === null ||
          existing.project.projectId !== parsed.expectedMapping.projectId ||
          existing.previousMapping.projectTargetSelectorMappingId !==
            parsed.expectedMapping.projectTargetSelectorMappingId ||
          existing.previousMapping.mappingGeneration !== parsed.expectedMapping.mappingGeneration ||
          !equalDigest(
            existing.previousMapping.targetDigest,
            parsed.expectedMapping.targetDigest,
          ) ||
          existing.previousMapping.workspaceSelectorId !==
            parsed.expectedMapping.workspaceSelectorId ||
          existing.mapping.mappingGeneration !== mappingGeneration ||
          !equalDigest(existing.mapping.targetDigest, targetDigest) ||
          existing.mapping.evidenceRef !== parsed.mappingEvidenceRef ||
          existing.mapping.target.kind !== "terminal_native" ||
          !sameTerminalTarget(existing.mapping.target, parsed.terminalTarget)
        ) {
          throw new HostStateRepositoryConflictError("mapping replacement intent collided");
        }
        return frozen({ ...existing, replayed: true });
      }
      assertJournalCapacity(current.server);
      const project = findProject(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.expectedMapping.projectId,
      );
      const previousMapping = findMapping(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.expectedMapping.projectTargetSelectorMappingId,
      );
      if (
        project === null ||
        project.state !== "current" ||
        previousMapping === null ||
        previousMapping.state !== "current" ||
        previousMapping.projectId !== project.projectId ||
        previousMapping.workspaceSelectorId !== parsed.expectedMapping.workspaceSelectorId ||
        previousMapping.mappingGeneration !== parsed.expectedMapping.mappingGeneration ||
        !equalDigest(previousMapping.targetDigest, parsed.expectedMapping.targetDigest) ||
        previousMapping.target.kind !== "terminal_native"
      ) {
        throw new HostStateRepositoryConflictError(
          "project target mapping compare-and-swap failed",
        );
      }
      const mapping = parseProjectTargetSelectorMappingRecord({
        projectTargetSelectorMappingId: mappingId,
        collaborationServerId: parsed.fence.collaborationServerId,
        projectId: project.projectId,
        workspaceSelectorId: previousMapping.workspaceSelectorId,
        target: parsed.terminalTarget,
        targetDigest,
        mappingGeneration,
        evidenceRef: parsed.mappingEvidenceRef,
        state: "current",
      });
      if (mapping.target.kind !== "terminal_native") {
        throw new HostStateRepositoryPersistenceError(
          "replacement mapping lost its terminal target",
        );
      }
      const terminalTarget = mapping.target;
      runExactlyOne(
        transaction,
        `UPDATE project_target_selector_mappings
         SET state = 'superseded'
         WHERE collaboration_server_id = ? AND project_id = ?
           AND workspace_selector_id = ?
           AND project_target_selector_mapping_id = ?
           AND mapping_generation = ? AND target_digest = ? AND state = 'current'`,
        [
          parsed.fence.collaborationServerId,
          project.projectId,
          previousMapping.workspaceSelectorId,
          previousMapping.projectTargetSelectorMappingId,
          previousMapping.mappingGeneration,
          previousMapping.targetDigest,
        ],
        "project target mapping compare-and-swap",
      );
      runExactlyOne(
        transaction,
        `INSERT INTO project_target_selector_mappings (
          project_target_selector_mapping_id, collaboration_server_id, project_id,
          workspace_selector_id, target_kind, target_product, target_access,
          terminal_project_ref, native_workspace_binding_id,
          nested_server_management_binding_id, target_server_id, target_project_id,
          target_workspace_selector_id, target_digest, mapping_generation, evidence_ref, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 'current')`,
        [
          mapping.projectTargetSelectorMappingId,
          mapping.collaborationServerId,
          mapping.projectId,
          mapping.workspaceSelectorId,
          terminalTarget.kind,
          terminalTarget.descriptor.product,
          terminalTarget.descriptor.access,
          terminalTarget.terminalProjectRef,
          terminalTarget.nativeWorkspaceBindingId,
          mapping.targetDigest,
          mapping.mappingGeneration,
          mapping.evidenceRef,
        ],
        "replacement project target mapping insert",
      );
      const journalEntry = buildJournalEntry(
        current.server,
        parsed.fence,
        current.nowMs,
        "project_target_mapping_replaced",
        "project_target_mapping",
        mapping.projectTargetSelectorMappingId,
        {
          collaborationServerId: parsed.fence.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
        },
      );
      insertJournalEntry(transaction, journalEntry);
      return frozen({
        project,
        previousMapping: parseProjectTargetSelectorMappingRecord({
          ...previousMapping,
          state: "superseded",
        }),
        mapping,
        journalEntry,
        replayed: false,
      });
    });
  }

  reconcileProjectTargetMappingReplacement(
    request: ReplaceProjectTargetMappingRequest,
  ): ReconcileProjectTargetMappingReplacementResult {
    const parsed = parseReplaceMappingRequest(request);
    return this.#executor.transaction((transaction) => {
      const mappingGeneration = checkedIncrement(
        parsed.expectedMapping.mappingGeneration,
        "project target mapping generation",
      );
      const targetDigest = syncProjectTargetDigest(parsed.terminalTarget);
      const mappingId = syncProjectTargetSelectorMappingId({
        collaborationServerId: parsed.fence.collaborationServerId,
        projectId: parsed.expectedMapping.projectId,
        workspaceSelectorId: parsed.expectedMapping.workspaceSelectorId,
        mappingGeneration,
        targetDigest,
      });
      const row = sqlGet(
        transaction,
        `SELECT ${selectColumns(MAPPING_ROW_KEYS)} FROM project_target_selector_mappings
         WHERE project_target_selector_mapping_id = ? LIMIT 1`,
        [mappingId],
      );
      if (row === undefined) {
        return frozen({ status: "not_applied", replacement: null });
      }
      const occupied = mappingFromRow(row);
      if (
        occupied.collaborationServerId !== parsed.fence.collaborationServerId ||
        occupied.projectId !== parsed.expectedMapping.projectId ||
        occupied.workspaceSelectorId !== parsed.expectedMapping.workspaceSelectorId ||
        occupied.mappingGeneration !== mappingGeneration ||
        !equalDigest(occupied.targetDigest, targetDigest)
      ) {
        return frozen({ status: "collision", replacement: null });
      }
      const existing = loadMappingReplacement(
        transaction,
        parsed.fence.collaborationServerId,
        mappingId,
      );
      if (existing === null) {
        throw new HostStateRepositoryPersistenceError(
          "mapping replacement reconciliation lost its derived mapping",
        );
      }
      if (
        existing.project.projectId !== parsed.expectedMapping.projectId ||
        existing.previousMapping.projectTargetSelectorMappingId !==
          parsed.expectedMapping.projectTargetSelectorMappingId ||
        existing.previousMapping.mappingGeneration !== parsed.expectedMapping.mappingGeneration ||
        !equalDigest(existing.previousMapping.targetDigest, parsed.expectedMapping.targetDigest) ||
        existing.previousMapping.workspaceSelectorId !==
          parsed.expectedMapping.workspaceSelectorId ||
        existing.mapping.evidenceRef !== parsed.mappingEvidenceRef ||
        existing.mapping.target.kind !== "terminal_native" ||
        !sameTerminalTarget(existing.mapping.target, parsed.terminalTarget)
      ) {
        return frozen({ status: "collision", replacement: null });
      }
      return frozen({
        status: "applied",
        replacement: frozen({ ...existing, replayed: true }),
      });
    });
  }

  reserveFirstTerminalChat(
    request: ReserveFirstTerminalChatRequest,
  ): TerminalChatReservationResult {
    const parsed = parseFirstRequest(request);
    if (!sameDescriptor(parsed.terminalTarget.descriptor, parsed.registration.descriptor)) {
      throw new HostStateContractError(
        "reserveFirstTerminalChat terminal target and registration descriptors must match",
      );
    }
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentFence(transaction, parsed.fence, this.#nowMs);
      const existing = loadTerminalReservation(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.registration.registrationAttemptId,
      );
      if (existing !== null) {
        if (
          !projectAllocationMatches(
            existing,
            "first_bootstrap",
            parsed.registration.registrationAttemptId,
            parsed.workspaceSelectorId,
            parsed.terminalTarget,
            parsed.mappingEvidenceRef,
          ) ||
          existing.chat.parentChatId !== null ||
          !sameRegistrationInput(parsed.registration, existing.registrationIntent, existing.binding)
        ) {
          throw new HostStateRepositoryConflictError("first terminal bootstrap intent collided");
        }
        return reservationResult(existing, true);
      }
      assertJournalCapacity(current.server);
      const globalIntent = findGlobalRegistrationIntent(
        transaction,
        parsed.registration.registrationAttemptId,
      );
      if (globalIntent !== null) {
        throw new HostStateRepositoryConflictError(
          "registration attempt is already allocated to another collaboration server",
        );
      }
      const partialProject = sqlGet(transaction, SELECT_PROJECT_BY_INTENT, [
        parsed.fence.collaborationServerId,
        parsed.registration.registrationAttemptId,
      ]);
      if (partialProject !== undefined) {
        const project = projectFromRow(partialProject);
        if (project.allocationKind === "first_bootstrap") {
          throw new HostStateRepositoryPersistenceError(
            "first bootstrap project exists without its terminal reservation",
          );
        }
        throw new HostStateRepositoryConflictError(
          "registration attempt is already used by an explicit project allocation",
        );
      }
      if (
        sqlGet(transaction, SELECT_ANY_PROJECT, [parsed.fence.collaborationServerId]) !== undefined
      ) {
        throw new HostStateRepositoryConflictError(
          "first bootstrap requires a collaboration server with no project",
        );
      }
      const projectId = allocateRandomId(transaction, "project", this.#randomBytes);
      const createdProject = insertProjectAndInitialMapping(transaction, {
        collaborationServerId: parsed.fence.collaborationServerId,
        projectId,
        allocationKind: "first_bootstrap",
        projectAllocationIntentId: parsed.registration.registrationAttemptId,
        workspaceSelectorId: parsed.workspaceSelectorId,
        terminalTarget: parsed.terminalTarget,
        mappingEvidenceRef: parsed.mappingEvidenceRef,
        createdAtMs: current.nowMs,
      });
      const createdTerminal = insertTerminalChatRows(transaction, this.#randomBytes, {
        collaborationServerId: parsed.fence.collaborationServerId,
        ...createdProject,
        parentChatId: null,
        registration: parsed.registration,
        createdAtMs: current.nowMs,
      });
      const journalEntry = buildJournalEntry(
        current.server,
        parsed.fence,
        current.nowMs,
        "project_bootstrapped",
        "project",
        createdProject.project.projectId,
        {
          collaborationServerId: parsed.fence.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
        },
      );
      insertJournalEntry(transaction, journalEntry);
      return frozen({
        ...createdProject,
        ...createdTerminal,
        journalEntry,
        replayed: false,
      });
    });
  }

  reserveAdditionalTerminalChat(
    request: ReserveAdditionalTerminalChatRequest,
  ): TerminalChatReservationResult {
    const parsed = parseAdditionalRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentFence(transaction, parsed.fence, this.#nowMs);
      const existing = loadTerminalReservation(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.registration.registrationAttemptId,
      );
      if (existing !== null) {
        if (
          existing.journalEntry.entryKind !== "terminal_chat_reserved" ||
          existing.project.projectId !== parsed.mappingFence.projectId ||
          existing.mapping.projectTargetSelectorMappingId !==
            parsed.mappingFence.projectTargetSelectorMappingId ||
          existing.mapping.workspaceSelectorId !== parsed.mappingFence.workspaceSelectorId ||
          existing.mapping.mappingGeneration !== parsed.mappingFence.mappingGeneration ||
          !equalDigest(existing.mapping.targetDigest, parsed.mappingFence.targetDigest) ||
          existing.chat.parentChatId !== parsed.parentChatId ||
          !sameRegistrationInput(parsed.registration, existing.registrationIntent, existing.binding)
        ) {
          throw new HostStateRepositoryConflictError("terminal chat reservation intent collided");
        }
        return reservationResult(existing, true);
      }
      assertJournalCapacity(current.server);
      const globalIntent = findGlobalRegistrationIntent(
        transaction,
        parsed.registration.registrationAttemptId,
      );
      if (globalIntent !== null) {
        throw new HostStateRepositoryConflictError(
          "registration attempt is already allocated to another collaboration server",
        );
      }
      const project = findProject(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.mappingFence.projectId,
      );
      const mapping = findMapping(
        transaction,
        parsed.fence.collaborationServerId,
        parsed.mappingFence.projectTargetSelectorMappingId,
      );
      if (
        project === null ||
        project.state !== "current" ||
        mapping === null ||
        mapping.state !== "current" ||
        mapping.projectId !== project.projectId ||
        mapping.workspaceSelectorId !== parsed.mappingFence.workspaceSelectorId ||
        mapping.mappingGeneration !== parsed.mappingFence.mappingGeneration ||
        !equalDigest(mapping.targetDigest, parsed.mappingFence.targetDigest) ||
        mapping.target.kind !== "terminal_native" ||
        !sameDescriptor(mapping.target.descriptor, parsed.registration.descriptor)
      ) {
        throw new HostStateRepositoryConflictError("project target mapping fence is not current");
      }
      if (parsed.parentChatId !== null) {
        const parent = findChat(
          transaction,
          parsed.fence.collaborationServerId,
          parsed.parentChatId,
        );
        if (
          parent === null ||
          parent.projectId !== project.projectId ||
          parent.state === "closed"
        ) {
          throw new HostStateRepositoryConflictError(
            "parent logical chat is not current in project",
          );
        }
      }
      const createdTerminal = insertTerminalChatRows(transaction, this.#randomBytes, {
        collaborationServerId: parsed.fence.collaborationServerId,
        project,
        mapping,
        parentChatId: parsed.parentChatId,
        registration: parsed.registration,
        createdAtMs: current.nowMs,
      });
      const journalEntry = buildJournalEntry(
        current.server,
        parsed.fence,
        current.nowMs,
        "terminal_chat_reserved",
        "logical_chat",
        createdTerminal.chat.logicalChatId,
        {
          collaborationServerId: parsed.fence.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
        },
      );
      insertJournalEntry(transaction, journalEntry);
      return frozen({
        project,
        mapping,
        ...createdTerminal,
        journalEntry,
        replayed: false,
      });
    });
  }

  acquireCoordinatorLease(request: AcquireCoordinatorLeaseRequest): AcquireCoordinatorLeaseResult {
    const parsed = parseAcquireRequest(request);
    return this.#executor.transaction((transaction) => {
      const now = trustedNow(this.#nowMs);
      const globallyExisting = sqlGet(
        transaction,
        `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM coordinator_leases
         WHERE coordinator_lease_id = ? LIMIT 1`,
        [parsed.candidateLeaseId],
      );
      if (globallyExisting !== undefined) {
        const storedLease = storedLeaseFromRow(globallyExisting);
        const { lease } = storedLease;
        if (lease.collaborationServerId !== parsed.collaborationServerId) {
          throw new HostStateRepositoryConflictError("coordinator lease ID is already occupied");
        }
        const expectedEpoch = checkedIncrement(
          parsed.expectedCoordinatorEpoch,
          "coordinator epoch",
        );
        if (
          lease.coordinatorEpoch !== expectedEpoch ||
          lease.ownerInstanceId !== parsed.ownerInstanceId ||
          storedLease.initialHeartbeatDeadlineMs - lease.acquiredAtMs !== parsed.leaseDurationMs
        ) {
          throw new HostStateRepositoryConflictError(
            "coordinator lease acquisition intent collided",
          );
        }
        if (parsed.expectedCurrentLeaseId === null) {
          if (parsed.expectedCoordinatorEpoch > 0) {
            const predecessorRow = sqlGet(transaction, SELECT_LEASE_BY_EPOCH, [
              parsed.collaborationServerId,
              parsed.expectedCoordinatorEpoch,
            ]);
            const predecessor = predecessorRow === undefined ? null : leaseFromRow(predecessorRow);
            if (
              predecessor === null ||
              predecessor.state !== "released" ||
              predecessor.releasedAtMs === null ||
              lease.acquiredAtMs < predecessor.releasedAtMs
            ) {
              throw new HostStateRepositoryConflictError(
                "coordinator acquisition predecessor did not have a null released pointer",
              );
            }
          }
        } else {
          const predecessor = findLease(
            transaction,
            parsed.collaborationServerId,
            parsed.expectedCurrentLeaseId,
          );
          if (
            predecessor === null ||
            predecessor.coordinatorEpoch !== parsed.expectedCoordinatorEpoch ||
            predecessor.state !== "current" ||
            predecessor.releasedAtMs !== null ||
            predecessor.heartbeatDeadlineMs > lease.acquiredAtMs
          ) {
            throw new HostStateRepositoryConflictError(
              "coordinator acquisition predecessor does not match",
            );
          }
        }
        const acquisition = loadLeaseAcquisition(
          transaction,
          parsed.collaborationServerId,
          parsed.candidateLeaseId,
        );
        if (acquisition === null) {
          throw new HostStateRepositoryPersistenceError(
            "coordinator lease disappeared during acquisition replay",
          );
        }
        const { journalEntry } = acquisition;
        const server = requireServer(transaction, parsed.collaborationServerId);
        const isCurrent =
          server.currentCoordinatorLeaseId === lease.coordinatorLeaseId &&
          server.currentCoordinatorEpoch === lease.coordinatorEpoch &&
          lease.state === "current" &&
          lease.releasedAtMs === null;
        return frozen({
          lease,
          journalEntry,
          replayed: true,
          isCurrent,
          unexpired:
            lease.state === "current" &&
            lease.releasedAtMs === null &&
            lease.acquiredAtMs <= now &&
            now < lease.heartbeatDeadlineMs,
        });
      }

      const server = requireServer(transaction, parsed.collaborationServerId);
      if (server.state === "closed") {
        throw new HostStateRepositoryConflictError(
          "closed collaboration server has no coordinator",
        );
      }
      if (
        server.currentCoordinatorLeaseId !== parsed.expectedCurrentLeaseId ||
        server.currentCoordinatorEpoch !== parsed.expectedCoordinatorEpoch
      ) {
        throw new HostStateRepositoryConflictError("coordinator lease compare-and-swap failed");
      }
      assertJournalCapacity(server);
      if (parsed.expectedCurrentLeaseId === null) {
        if (parsed.expectedCoordinatorEpoch > 0) {
          const predecessorRow = sqlGet(transaction, SELECT_LEASE_BY_EPOCH, [
            parsed.collaborationServerId,
            parsed.expectedCoordinatorEpoch,
          ]);
          const predecessor = predecessorRow === undefined ? null : leaseFromRow(predecessorRow);
          if (
            predecessor === null ||
            predecessor.state !== "released" ||
            predecessor.releasedAtMs === null ||
            now < predecessor.releasedAtMs
          ) {
            throw new HostStateRepositoryConflictError(
              "null coordinator pointer is not backed by a released predecessor",
            );
          }
        }
      } else {
        const predecessor = findLease(
          transaction,
          parsed.collaborationServerId,
          parsed.expectedCurrentLeaseId,
        );
        if (
          predecessor === null ||
          predecessor.coordinatorEpoch !== parsed.expectedCoordinatorEpoch ||
          predecessor.state !== "current" ||
          predecessor.releasedAtMs !== null
        ) {
          throw new HostStateRepositoryConflictError("coordinator predecessor is invalid");
        }
        if (now < predecessor.heartbeatDeadlineMs) {
          throw new HostStateRepositoryConflictError("current coordinator lease has not expired");
        }
        // Expiry revokes authority by moving the server pointer. The historical
        // predecessor row is deliberately not rewritten or deleted.
      }
      const coordinatorEpoch = checkedIncrement(
        parsed.expectedCoordinatorEpoch,
        "coordinator epoch",
      );
      const heartbeatDeadlineMs = checkedAdd(
        now,
        parsed.leaseDurationMs,
        "coordinator heartbeat deadline",
      );
      const lease = parseCoordinatorLeaseRecord({
        coordinatorLeaseId: parsed.candidateLeaseId,
        collaborationServerId: parsed.collaborationServerId,
        coordinatorEpoch,
        ownerInstanceId: parsed.ownerInstanceId,
        acquiredAtMs: now,
        heartbeatDeadlineMs,
        releasedAtMs: null,
        state: "current",
      });
      runExactlyOne(
        transaction,
        `INSERT INTO coordinator_leases (
          coordinator_lease_id, collaboration_server_id, coordinator_epoch,
          owner_instance_id, acquired_at_ms, initial_heartbeat_deadline_ms,
          heartbeat_deadline_ms, released_at_ms, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'current')`,
        [
          lease.coordinatorLeaseId,
          lease.collaborationServerId,
          lease.coordinatorEpoch,
          lease.ownerInstanceId,
          lease.acquiredAtMs,
          lease.heartbeatDeadlineMs,
          lease.heartbeatDeadlineMs,
        ],
        "coordinator lease insert",
      );
      runExactlyOne(
        transaction,
        `UPDATE collaboration_servers
         SET current_coordinator_epoch = ?, current_coordinator_lease_id = ?
         WHERE collaboration_server_id = ?
           AND current_coordinator_epoch = ?
           AND current_coordinator_lease_id IS ?`,
        [
          coordinatorEpoch,
          parsed.candidateLeaseId,
          parsed.collaborationServerId,
          parsed.expectedCoordinatorEpoch,
          parsed.expectedCurrentLeaseId,
        ],
        "coordinator lease pointer compare-and-swap",
      );
      const newFence = parseCoordinatorLeaseFence({
        collaborationServerId: parsed.collaborationServerId,
        coordinatorLeaseId: parsed.candidateLeaseId,
        coordinatorEpoch,
      });
      const journalEntry = buildJournalEntry(
        server,
        newFence,
        now,
        "coordinator_lease_acquired",
        "coordinator_lease",
        parsed.candidateLeaseId,
        {
          collaborationServerId: parsed.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
        },
      );
      insertJournalEntry(transaction, journalEntry);
      return frozen({
        lease,
        journalEntry,
        replayed: false,
        isCurrent: true,
        unexpired: true,
      });
    });
  }

  reconcileCoordinatorAcquisition(
    request: AcquireCoordinatorLeaseRequest,
  ): AcquireCoordinatorLeaseResult | null {
    const parsed = parseAcquireRequest(request);
    return this.#executor.transaction((transaction) => {
      const row = sqlGet(
        transaction,
        `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM coordinator_leases
         WHERE coordinator_lease_id = ? LIMIT 1`,
        [parsed.candidateLeaseId],
      );
      if (row === undefined) return null;
      const storedLease = storedLeaseFromRow(row);
      assertAcquisitionIntentMatches(transaction, parsed, storedLease);
      const acquisition = loadLeaseAcquisition(
        transaction,
        parsed.collaborationServerId,
        parsed.candidateLeaseId,
      );
      if (acquisition === null) {
        throw new HostStateRepositoryPersistenceError(
          "coordinator acquisition reconciliation lost its candidate lease",
        );
      }
      const server = requireServer(transaction, parsed.collaborationServerId);
      const now = trustedNow(this.#nowMs);
      const isCurrent =
        server.currentCoordinatorLeaseId === acquisition.lease.coordinatorLeaseId &&
        server.currentCoordinatorEpoch === acquisition.lease.coordinatorEpoch &&
        acquisition.lease.state === "current" &&
        acquisition.lease.releasedAtMs === null;
      return frozen({
        lease: acquisition.lease,
        journalEntry: acquisition.journalEntry,
        replayed: true,
        isCurrent,
        unexpired:
          acquisition.lease.state === "current" &&
          acquisition.lease.releasedAtMs === null &&
          acquisition.lease.acquiredAtMs <= now &&
          now < acquisition.lease.heartbeatDeadlineMs,
      });
    });
  }

  renewCoordinatorLease(request: RenewCoordinatorLeaseRequest): RenewCoordinatorLeaseResult {
    const parsed = parseRenewRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentFence(transaction, parsed.fence, this.#nowMs);
      if (parsed.newHeartbeatDeadlineMs <= current.nowMs) {
        throw new HostStateRepositoryConflictError(
          "renewed coordinator deadline is not in the future",
        );
      }
      if (current.lease.heartbeatDeadlineMs === parsed.newHeartbeatDeadlineMs) {
        return frozen({ lease: current.lease, replayed: true });
      }
      if (current.lease.heartbeatDeadlineMs !== parsed.expectedHeartbeatDeadlineMs) {
        throw new HostStateRepositoryConflictError("coordinator heartbeat compare-and-swap failed");
      }
      runExactlyOne(
        transaction,
        `UPDATE coordinator_leases
         SET heartbeat_deadline_ms = ?
         WHERE collaboration_server_id = ? AND coordinator_lease_id = ?
           AND coordinator_epoch = ? AND state = 'current'
           AND released_at_ms IS NULL AND heartbeat_deadline_ms = ?`,
        [
          parsed.newHeartbeatDeadlineMs,
          parsed.fence.collaborationServerId,
          parsed.fence.coordinatorLeaseId,
          parsed.fence.coordinatorEpoch,
          parsed.expectedHeartbeatDeadlineMs,
        ],
        "coordinator heartbeat compare-and-swap",
      );
      return frozen({
        lease: parseCoordinatorLeaseRecord({
          ...current.lease,
          heartbeatDeadlineMs: parsed.newHeartbeatDeadlineMs,
        }),
        replayed: false,
      });
    });
  }

  releaseCoordinatorLease(request: ReleaseCoordinatorLeaseRequest): ReleaseCoordinatorLeaseResult {
    const parsed = parseReleaseRequest(request);
    return this.#executor.transaction((transaction) => {
      const current = assertCurrentFence(transaction, parsed.fence, this.#nowMs);
      assertJournalCapacity(current.server);
      const released = parseCoordinatorLeaseRecord({
        ...current.lease,
        releasedAtMs: current.nowMs,
        state: "released",
      });
      runExactlyOne(
        transaction,
        `UPDATE coordinator_leases
         SET released_at_ms = ?, state = 'released'
         WHERE collaboration_server_id = ? AND coordinator_lease_id = ?
           AND coordinator_epoch = ? AND state = 'current' AND released_at_ms IS NULL`,
        [
          current.nowMs,
          parsed.fence.collaborationServerId,
          parsed.fence.coordinatorLeaseId,
          parsed.fence.coordinatorEpoch,
        ],
        "coordinator lease release",
      );
      const journalEntry = buildJournalEntry(
        current.server,
        parsed.fence,
        current.nowMs,
        "coordinator_lease_released",
        "coordinator_lease",
        parsed.fence.coordinatorLeaseId,
        {
          collaborationServerId: parsed.fence.collaborationServerId,
          scopeKind: "server_control",
          logicalChatId: null,
        },
      );
      // The journal trigger fences against the still-current server pointer.
      insertJournalEntry(transaction, journalEntry);
      runExactlyOne(
        transaction,
        `UPDATE collaboration_servers
         SET current_coordinator_lease_id = NULL
         WHERE collaboration_server_id = ? AND current_coordinator_lease_id = ?
           AND current_coordinator_epoch = ?`,
        [
          parsed.fence.collaborationServerId,
          parsed.fence.coordinatorLeaseId,
          parsed.fence.coordinatorEpoch,
        ],
        "coordinator lease pointer release",
      );
      return frozen({ lease: released, journalEntry });
    });
  }

  reconcileCoordinatorRenewal(
    request: ReconcileCoordinatorRenewalRequest,
  ): ReconcileCoordinatorRenewalResult | null {
    const row = parseExactRecord(
      request,
      [
        "collaborationServerId",
        "coordinatorLeaseId",
        "expectedHeartbeatDeadlineMs",
        "newHeartbeatDeadlineMs",
      ],
      "reconcileCoordinatorRenewal",
    );
    const serverId = parseA1CanonicalId(
      "collaborationServer",
      row.collaborationServerId,
      "reconcileCoordinatorRenewal.collaborationServerId",
    );
    const leaseId = parseA1CanonicalId(
      "coordinatorLease",
      row.coordinatorLeaseId,
      "reconcileCoordinatorRenewal.coordinatorLeaseId",
    );
    const expected = parseNonNegativeSafeInteger(
      row.expectedHeartbeatDeadlineMs,
      "reconcileCoordinatorRenewal.expectedHeartbeatDeadlineMs",
    );
    const replacement = parseNonNegativeSafeInteger(
      row.newHeartbeatDeadlineMs,
      "reconcileCoordinatorRenewal.newHeartbeatDeadlineMs",
    );
    if (replacement <= expected) {
      throw new HostStateContractError(
        "reconcileCoordinatorRenewal.newHeartbeatDeadlineMs must strictly extend the expected deadline",
      );
    }
    return this.#executor.transaction((transaction) => {
      const acquisition = loadLeaseAcquisition(transaction, serverId, leaseId);
      if (acquisition === null) return null;
      const { lease } = acquisition;
      const status =
        lease.heartbeatDeadlineMs === replacement
          ? "applied"
          : lease.heartbeatDeadlineMs === expected
            ? "not_applied"
            : "superseded_or_indeterminate";
      return frozen({ lease, status });
    });
  }

  reconcileCoordinatorRelease(
    collaborationServerId: CollaborationServerId,
    coordinatorLeaseId: CoordinatorLeaseId,
  ): ReconcileCoordinatorReleaseResult | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const leaseId = parseA1CanonicalId("coordinatorLease", coordinatorLeaseId);
    return this.#executor.transaction((transaction) => {
      const acquisition = loadLeaseAcquisition(transaction, serverId, leaseId);
      if (acquisition === null) return null;
      const { lease, releaseJournalEntry } = acquisition;
      if (lease.state === "released") {
        if (releaseJournalEntry === null || lease.releasedAtMs === null) {
          throw new HostStateRepositoryPersistenceError(
            "released coordinator lease has no release journal entry",
          );
        }
        requireExactJournalLink(releaseJournalEntry, {
          entryKind: "coordinator_lease_released",
          subjectKind: "coordinator_lease",
          subjectId: leaseId,
          scopeKind: "server_control",
          logicalChatId: null,
        });
        if (
          releaseJournalEntry.coordinatorLeaseId !== leaseId ||
          releaseJournalEntry.coordinatorEpoch !== lease.coordinatorEpoch ||
          releaseJournalEntry.committedAtMs !== lease.releasedAtMs
        ) {
          throw new HostStateRepositoryPersistenceError(
            "coordinator release journal linkage is invalid",
          );
        }
        return frozen({ lease, releaseJournalEntry, status: "released" });
      }
      if (releaseJournalEntry !== null) {
        throw new HostStateRepositoryPersistenceError(
          "unreleased coordinator lease has a release journal entry",
        );
      }
      const server = requireServer(transaction, serverId);
      const status =
        server.currentCoordinatorLeaseId === leaseId &&
        server.currentCoordinatorEpoch === lease.coordinatorEpoch
          ? "not_released"
          : "superseded_or_indeterminate";
      return frozen({ lease, releaseJournalEntry: null, status });
    });
  }

  readDefaultCollaborationServer(): DefaultCollaborationServerResult | null {
    return this.#executor.transaction((transaction) => {
      const row = sqlGet(transaction, SELECT_PROFILE);
      if (row === undefined) return null;
      const profile = profileFromRow(row);
      const server = requireServer(transaction, profile.defaultCollaborationServerId);
      if (
        profile.machineIdentityId !== this.#machineIdentityId ||
        server.machineIdentityId !== this.#machineIdentityId ||
        server.state !== "installing"
      ) {
        throw new HostStateRepositoryPersistenceError("default profile linkage is invalid");
      }
      validateServerLeasePointer(transaction, server);
      return frozen({ profile, server, created: false });
    });
  }

  readProjectAllocation(
    collaborationServerId: CollaborationServerId,
    projectAllocationIntentId: A1SafeId,
  ): AllocateExplicitProjectResult | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const intentId = parseA1SafeId(projectAllocationIntentId);
    return this.#executor.transaction((transaction) => {
      requireServer(transaction, serverId);
      const allocation = loadProjectAllocation(transaction, serverId, intentId);
      return allocation === null ? null : frozen({ ...allocation, replayed: true });
    });
  }

  listProjects(collaborationServerId: CollaborationServerId): readonly ProjectRecord[] {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    return this.#executor.transaction((transaction) => {
      requireServer(transaction, serverId);
      const projects = sqlAll(
        transaction,
        `SELECT ${selectColumns(PROJECT_ROW_KEYS)} FROM projects
         WHERE collaboration_server_id = ? ORDER BY project_id`,
        [serverId],
      ).map(projectFromRow);
      for (const project of projects) {
        loadProjectAllocation(transaction, serverId, project.projectAllocationIntentId);
      }
      return Object.freeze(projects);
    });
  }

  listProjectTargetMappings(
    collaborationServerId: CollaborationServerId,
    projectId: ProjectId,
    workspaceSelectorId: A1SafeId,
  ): readonly ProjectTargetSelectorMappingRecord[] {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const selectedProjectId = parseA1CanonicalId("project", projectId);
    const selectorId = parseA1SafeId(workspaceSelectorId);
    return this.#executor.transaction((transaction) => {
      requireServer(transaction, serverId);
      return loadValidatedMappingChain(transaction, serverId, selectedProjectId, selectorId);
    });
  }

  readCurrentProjectTargetMapping(
    collaborationServerId: CollaborationServerId,
    projectId: ProjectId,
    workspaceSelectorId: A1SafeId,
  ): ProjectTargetSelectorMappingRecord | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const selectedProjectId = parseA1CanonicalId("project", projectId);
    const selectorId = parseA1SafeId(workspaceSelectorId);
    return this.#executor.transaction((transaction) => {
      requireServer(transaction, serverId);
      const chain = loadValidatedMappingChain(transaction, serverId, selectedProjectId, selectorId);
      return chain.at(-1) ?? null;
    });
  }

  readTerminalReservation(
    collaborationServerId: CollaborationServerId,
    registrationAttemptId: RegistrationAttemptId,
  ): TerminalChatReservationResult | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const attemptId = parseA1CanonicalId("registrationAttempt", registrationAttemptId);
    return this.#executor.transaction((transaction) => {
      requireServer(transaction, serverId);
      const graph = loadTerminalReservation(transaction, serverId, attemptId);
      return graph === null ? null : reservationResult(graph, true);
    });
  }

  listTerminalReservations(
    collaborationServerId: CollaborationServerId,
    projectId?: ProjectId,
  ): readonly TerminalChatReservationResult[] {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const selectedProjectId =
      projectId === undefined ? undefined : parseA1CanonicalId("project", projectId);
    return this.#executor.transaction((transaction) => {
      requireServer(transaction, serverId);
      const qualifiedIntentColumns = INTENT_ROW_KEYS.map(
        (column) => `intent.${column} AS ${column}`,
      ).join(", ");
      const rows = sqlAll(
        transaction,
        selectedProjectId === undefined
          ? `SELECT ${qualifiedIntentColumns}
             FROM native_registration_intents AS intent
             WHERE intent.collaboration_server_id = ?
             ORDER BY intent.registration_attempt_id`
          : `SELECT ${qualifiedIntentColumns}
             FROM native_registration_intents AS intent
             JOIN native_bindings AS binding
               ON binding.collaboration_server_id = intent.collaboration_server_id
               AND binding.native_binding_id = intent.native_binding_id
             WHERE intent.collaboration_server_id = ? AND binding.project_id = ?
             ORDER BY intent.registration_attempt_id`,
        selectedProjectId === undefined ? [serverId] : [serverId, selectedProjectId],
      );
      const reservations = rows.map((row) => {
        const intent = intentFromRow(row);
        const graph = loadTerminalReservation(transaction, serverId, intent.registrationAttemptId);
        if (graph === null) {
          throw new HostStateRepositoryPersistenceError(
            "terminal reservation inventory contains a partial graph",
          );
        }
        if (selectedProjectId !== undefined && graph.project.projectId !== selectedProjectId) {
          throw new HostStateRepositoryPersistenceError(
            "terminal reservation inventory crossed project scope",
          );
        }
        return reservationResult(graph, true);
      });
      return Object.freeze(reservations);
    });
  }

  readLogicalChat(
    collaborationServerId: CollaborationServerId,
    logicalChatId: LogicalChatId,
  ): LogicalChatRecord | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const chatId = parseA1CanonicalId("logicalChat", logicalChatId);
    return this.#executor.transaction((transaction) => {
      const chat = findChat(transaction, serverId, chatId);
      if (chat !== null) validateChatLinkage(transaction, chat);
      return chat;
    });
  }

  listLogicalChats(
    collaborationServerId: CollaborationServerId,
    projectId: ProjectId,
  ): readonly LogicalChatRecord[] {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const selectedProjectId = parseA1CanonicalId("project", projectId);
    return this.#executor.transaction((transaction) => {
      const project = findProject(transaction, serverId, selectedProjectId);
      if (project === null) return Object.freeze([]);
      const chats = sqlAll(
        transaction,
        `SELECT ${selectColumns(CHAT_ROW_KEYS)} FROM logical_chats
         WHERE collaboration_server_id = ? AND project_id = ?
         ORDER BY logical_chat_id`,
        [serverId, selectedProjectId],
      ).map(chatFromRow);
      for (const chat of chats) validateChatLinkage(transaction, chat);
      return Object.freeze(chats);
    });
  }

  listNativeBindings(
    collaborationServerId: CollaborationServerId,
    logicalChatId: LogicalChatId,
  ): readonly NativeBindingRecord[] {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const chatId = parseA1CanonicalId("logicalChat", logicalChatId);
    return this.#executor.transaction((transaction) => {
      const chat = findChat(transaction, serverId, chatId);
      if (chat === null) return Object.freeze([]);
      validateChatLinkage(transaction, chat);
      const bindings = sqlAll(
        transaction,
        `SELECT ${selectColumns(BINDING_ROW_KEYS)} FROM native_bindings
         WHERE collaboration_server_id = ? AND logical_chat_id = ?
         ORDER BY native_binding_id`,
        [serverId, chatId],
      ).map(bindingFromRow);
      for (const binding of bindings) {
        if (binding.projectId !== chat.projectId) {
          throw new HostStateRepositoryPersistenceError(
            "native binding inventory crosses project scope",
          );
        }
      }
      return Object.freeze(bindings);
    });
  }

  readCoordinatorLease(
    collaborationServerId: CollaborationServerId,
    coordinatorLeaseId: CoordinatorLeaseId,
  ): CoordinatorLeaseRecord | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const leaseId = parseA1CanonicalId("coordinatorLease", coordinatorLeaseId);
    return this.#executor.transaction((transaction) => {
      const acquisition = loadLeaseAcquisition(transaction, serverId, leaseId);
      if (acquisition !== null) {
        const server = requireServer(transaction, serverId);
        if (acquisition.lease.coordinatorEpoch > server.currentCoordinatorEpoch) {
          throw new HostStateRepositoryPersistenceError("lease epoch is ahead of its server");
        }
      }
      return acquisition?.lease ?? null;
    });
  }

  readCoordinatorLeaseAcquisition(
    collaborationServerId: CollaborationServerId,
    coordinatorLeaseId: CoordinatorLeaseId,
  ): AcquireCoordinatorLeaseResult | null {
    const serverId = parseA1CanonicalId("collaborationServer", collaborationServerId);
    const leaseId = parseA1CanonicalId("coordinatorLease", coordinatorLeaseId);
    return this.#executor.transaction((transaction) => {
      const acquisition = loadLeaseAcquisition(transaction, serverId, leaseId);
      if (acquisition === null) return null;
      const { journalEntry, lease } = acquisition;
      const server = requireServer(transaction, serverId);
      const now = trustedNow(this.#nowMs);
      return frozen({
        lease,
        journalEntry,
        replayed: true,
        isCurrent:
          server.currentCoordinatorLeaseId === lease.coordinatorLeaseId &&
          server.currentCoordinatorEpoch === lease.coordinatorEpoch &&
          lease.state === "current" &&
          lease.releasedAtMs === null,
        unexpired:
          lease.state === "current" &&
          lease.releasedAtMs === null &&
          lease.acquiredAtMs <= now &&
          now < lease.heartbeatDeadlineMs,
      });
    });
  }
}

function validateServerLeasePointer(
  transaction: HostStateRepositorySqlTransaction,
  server: CollaborationServerRecord,
): void {
  if (server.currentCoordinatorLeaseId === null) return;
  const lease = findLease(
    transaction,
    server.collaborationServerId,
    server.currentCoordinatorLeaseId,
  );
  if (
    lease === null ||
    lease.coordinatorEpoch !== server.currentCoordinatorEpoch ||
    lease.state !== "current" ||
    lease.releasedAtMs !== null
  ) {
    throw new HostStateRepositoryPersistenceError("server coordinator pointer is invalid");
  }
}

function validateChatLinkage(
  transaction: HostStateRepositorySqlTransaction,
  chat: LogicalChatRecord,
  allowActivatedBinding = true,
): void {
  const project = findProject(transaction, chat.collaborationServerId, chat.projectId);
  const mapping = findMapping(
    transaction,
    chat.collaborationServerId,
    chat.projectTargetSelectorMappingId,
  );
  if (
    project === null ||
    project.state !== "current" ||
    mapping === null ||
    mapping.projectId !== project.projectId ||
    mapping.collaborationServerId !== chat.collaborationServerId ||
    mapping.target.kind !== "terminal_native" ||
    (mapping.state !== "current" && mapping.state !== "superseded")
  ) {
    throw new HostStateRepositoryPersistenceError("logical chat project mapping is invalid");
  }
  if (chat.parentChatId !== null) {
    const parent = findChat(transaction, chat.collaborationServerId, chat.parentChatId);
    if (parent === null || parent.projectId !== chat.projectId) {
      throw new HostStateRepositoryPersistenceError("logical chat parent linkage is invalid");
    }
  }
  if (
    chat.currentNativeBindingId === null ||
    chat.currentInwardEdgeId === null ||
    chat.state !== "recovering" ||
    chat.topologyGeneration !== 1 ||
    chat.nextViewerProjectionSeq !== 0
  ) {
    throw new HostStateRepositoryPersistenceError("terminal chat current pointers are invalid");
  }
  const binding = findBinding(transaction, chat.collaborationServerId, chat.currentNativeBindingId);
  const edge = findEdge(transaction, chat.collaborationServerId, chat.currentInwardEdgeId);
  const bindingIsDormant =
    binding?.state === "starting" &&
    binding.semanticConversationId === null &&
    binding.currentBindingIncarnationId === null;
  const bindingIsActivated =
    allowActivatedBinding &&
    binding?.state === "current" &&
    binding.semanticConversationId !== null &&
    binding.currentBindingIncarnationId !== null;
  if (
    binding === null ||
    edge === null ||
    binding.logicalChatId !== chat.logicalChatId ||
    binding.projectId !== chat.projectId ||
    (!bindingIsDormant && !bindingIsActivated) ||
    !sameDescriptor(binding.descriptor, mapping.target.descriptor) ||
    edge.representedLogicalChatId !== chat.logicalChatId ||
    edge.targetKind !== "native-harness" ||
    edge.targetNativeBindingId !== binding.nativeBindingId ||
    edge.targetServerId !== null ||
    edge.targetLogicalChatId !== null ||
    edge.rootPathCertificateId !== null ||
    edge.currentConnectionEpoch !== 0 ||
    edge.currentLiveLeaseId !== null ||
    edge.currentCapabilitySnapshotId !== null ||
    edge.state !== "installing"
  ) {
    throw new HostStateRepositoryPersistenceError("logical chat terminal linkage is invalid");
  }
}

/**
 * Validate every selected A1.2 row in one already-open coherent snapshot.
 * The secure SQLite opener calls this before any writable connection opens and
 * again after migration/finalization. It performs no mutation.
 */
export function validateHostStateRepositorySnapshot(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  schemaVersion = 3,
): void {
  const machineId = parseMachineIdentityId(machineIdentityId);
  const allowActivatedBinding = schemaVersion >= 5;
  const servers = sqlAll(
    transaction,
    `SELECT ${selectColumns(SERVER_ROW_KEYS)} FROM collaboration_servers
     ORDER BY collaboration_server_id`,
  ).map(serverFromRow);
  const profiles = sqlAll(
    transaction,
    `SELECT ${selectColumns(PROFILE_ROW_KEYS)} FROM host_state_profiles
     ORDER BY state_profile_id`,
  ).map(profileFromRow);
  const projects = sqlAll(
    transaction,
    `SELECT ${selectColumns(PROJECT_ROW_KEYS)} FROM projects
     ORDER BY collaboration_server_id, project_id`,
  ).map(projectFromRow);
  const mappings = sqlAll(
    transaction,
    `SELECT ${selectColumns(MAPPING_ROW_KEYS)} FROM project_target_selector_mappings
     ORDER BY collaboration_server_id, project_id, workspace_selector_id, mapping_generation`,
  ).map(mappingFromRow);
  const chats = sqlAll(
    transaction,
    `SELECT ${selectColumns(CHAT_ROW_KEYS)} FROM logical_chats
     ORDER BY collaboration_server_id, logical_chat_id`,
  ).map(chatFromRow);
  const bindings = sqlAll(
    transaction,
    `SELECT ${selectColumns(BINDING_ROW_KEYS)} FROM native_bindings
     ORDER BY collaboration_server_id, native_binding_id`,
  ).map(bindingFromRow);
  const intents = sqlAll(
    transaction,
    `SELECT ${selectColumns(INTENT_ROW_KEYS)} FROM native_registration_intents
     ORDER BY collaboration_server_id, registration_attempt_id`,
  ).map(intentFromRow);
  const edges = sqlAll(
    transaction,
    `SELECT ${selectColumns(EDGE_ROW_KEYS)} FROM inward_collaboration_edges
     ORDER BY represented_server_id, inward_edge_id`,
  ).map(edgeFromRow);
  const storedLeases = sqlAll(
    transaction,
    `SELECT ${selectColumns(LEASE_ROW_KEYS)} FROM coordinator_leases
     ORDER BY collaboration_server_id, coordinator_epoch`,
  ).map(storedLeaseFromRow);
  const leases = storedLeases.map(({ lease }) => lease);
  const journal = sqlAll(
    transaction,
    `SELECT ${selectColumns(JOURNAL_ROW_KEYS)} FROM control_journal_entries
     ORDER BY collaboration_server_id, journal_offset`,
  ).map(journalFromRow);

  const key = (serverId: string, id: string): string => `${serverId}\0${id}`;
  const serverById = new Map(servers.map((server) => [server.collaborationServerId, server]));
  const projectById = new Map(
    projects.map((project) => [key(project.collaborationServerId, project.projectId), project]),
  );
  const mappingById = new Map(
    mappings.map((mapping) => [
      key(mapping.collaborationServerId, mapping.projectTargetSelectorMappingId),
      mapping,
    ]),
  );
  const chatById = new Map(
    chats.map((chat) => [key(chat.collaborationServerId, chat.logicalChatId), chat]),
  );
  const bindingById = new Map(
    bindings.map((binding) => [
      key(binding.collaborationServerId, binding.nativeBindingId),
      binding,
    ]),
  );
  const leaseById = new Map(
    leases.map((lease) => [key(lease.collaborationServerId, lease.coordinatorLeaseId), lease]),
  );
  const journalBySubject = new Map<string, HostStateJournalEntry>();
  const expectedJournalCorrelations = new Set<string>();
  const expectJournalCorrelation = (
    serverId: CollaborationServerId,
    entryKind: HostStateJournalEntryKind,
    subjectId: A1SafeId,
  ): void => {
    expectedJournalCorrelations.add(`${serverId}\0${entryKind}\0${subjectId}`);
  };
  for (const entry of journal) {
    const correlation = `${entry.collaborationServerId}\0${entry.entryKind}\0${entry.subjectId}`;
    if (journalBySubject.has(correlation)) {
      throw new HostStateRepositoryPersistenceError(
        "control journal contains a duplicate replay correlation",
      );
    }
    journalBySubject.set(correlation, entry);
  }

  for (const server of servers) {
    if (
      server.machineIdentityId !== machineId ||
      server.state !== "installing" ||
      server.nextServerSignatureSeq !== 0 ||
      server.nextCommandSeq !== 0
    ) {
      throw new HostStateRepositoryPersistenceError(
        "collaboration server is not the dormant server for this database",
      );
    }
    validateServerLeasePointer(transaction, server);
  }
  if (
    (servers.length === 0 && profiles.length !== 0) ||
    (servers.length !== 0 && (servers.length !== 1 || profiles.length !== 1))
  ) {
    throw new HostStateRepositoryPersistenceError(
      "schema-v3 bootstrap must be empty or contain exactly one default profile and server",
    );
  }
  for (const profile of profiles) {
    const server = serverById.get(profile.defaultCollaborationServerId);
    if (
      profile.machineIdentityId !== machineId ||
      server === undefined ||
      server.machineIdentityId !== profile.machineIdentityId ||
      server.createdAtMs !== profile.createdAtMs
    ) {
      throw new HostStateRepositoryPersistenceError("host state profile linkage is invalid");
    }
  }

  for (const project of projects) {
    expectJournalCorrelation(
      project.collaborationServerId,
      "project_bootstrapped",
      project.projectId,
    );
    if (!serverById.has(project.collaborationServerId) || project.state !== "current") {
      throw new HostStateRepositoryPersistenceError("project has no collaboration server");
    }
    const mapping = mappingById.get(
      key(project.collaborationServerId, project.initialProjectTargetSelectorMappingId),
    );
    if (
      mapping === undefined ||
      mapping.projectId !== project.projectId ||
      mapping.workspaceSelectorId !== project.initialWorkspaceSelectorId ||
      mapping.mappingGeneration !== 1 ||
      mapping.target.kind !== "terminal_native" ||
      !equalDigest(mapping.targetDigest, project.initialTargetDigest)
    ) {
      throw new HostStateRepositoryPersistenceError("project initial mapping is invalid");
    }
    const entry = journalBySubject.get(
      `${project.collaborationServerId}\0project_bootstrapped\0${project.projectId}`,
    );
    if (
      entry === undefined ||
      entry.subjectKind !== "project" ||
      entry.committedAtMs !== project.createdAtMs
    ) {
      throw new HostStateRepositoryPersistenceError("project bootstrap journal is missing");
    }
    if (project.allocationKind === "first_bootstrap") {
      let attemptId: RegistrationAttemptId;
      try {
        attemptId = parseA1CanonicalId(
          "registrationAttempt",
          project.projectAllocationIntentId,
          "project.projectAllocationIntentId",
        );
      } catch (error) {
        throw new HostStateRepositoryPersistenceError(
          "first-bootstrap project allocation intent is not a registration attempt",
          { cause: error },
        );
      }
      const graph = loadTerminalReservation(
        transaction,
        project.collaborationServerId,
        attemptId,
        allowActivatedBinding,
      );
      if (
        graph === null ||
        graph.project.projectId !== project.projectId ||
        graph.registrationIntent.registrationAttemptId !== attemptId ||
        graph.journalEntry.entryKind !== "project_bootstrapped" ||
        graph.journalEntry.subjectId !== project.projectId
      ) {
        throw new HostStateRepositoryPersistenceError(
          "first-bootstrap project terminal graph is incomplete",
        );
      }
    }
  }
  for (const server of servers) {
    const serverProjects = projects.filter(
      (project) => project.collaborationServerId === server.collaborationServerId,
    );
    if (serverProjects.length === 0) continue;
    const firstProjects = serverProjects.filter(
      (project) => project.allocationKind === "first_bootstrap",
    );
    const firstProject = firstProjects[0];
    if (firstProjects.length !== 1 || firstProject === undefined) {
      throw new HostStateRepositoryPersistenceError(
        "a server with projects must have exactly one first-bootstrap project",
      );
    }
    const firstEntry = journalBySubject.get(
      `${server.collaborationServerId}\0project_bootstrapped\0${firstProject.projectId}`,
    );
    if (firstEntry === undefined) {
      throw new HostStateRepositoryPersistenceError("first-bootstrap project journal is missing");
    }
    for (const project of serverProjects) {
      if (project.allocationKind !== "explicit_new_project") continue;
      const explicitEntry = journalBySubject.get(
        `${server.collaborationServerId}\0project_bootstrapped\0${project.projectId}`,
      );
      if (explicitEntry === undefined || explicitEntry.journalOffset <= firstEntry.journalOffset) {
        throw new HostStateRepositoryPersistenceError(
          "explicit project journal precedes the first bootstrap",
        );
      }
    }
  }

  const mappingChains = new Map<string, ProjectTargetSelectorMappingRecord[]>();
  for (const mapping of mappings) {
    if (
      !projectById.has(key(mapping.collaborationServerId, mapping.projectId)) ||
      mapping.target.kind !== "terminal_native" ||
      (mapping.state !== "current" && mapping.state !== "superseded")
    ) {
      throw new HostStateRepositoryPersistenceError("selector mapping has no project");
    }
    const chainKey = `${mapping.collaborationServerId}\0${mapping.projectId}\0${mapping.workspaceSelectorId}`;
    const chain = mappingChains.get(chainKey) ?? [];
    chain.push(mapping);
    mappingChains.set(chainKey, chain);
  }
  for (const chain of mappingChains.values()) {
    chain.sort((left, right) => left.mappingGeneration - right.mappingGeneration);
    const initial = chain[0];
    if (initial === undefined) {
      throw new HostStateRepositoryPersistenceError("selector mapping chain is empty");
    }
    const project = projectById.get(key(initial.collaborationServerId, initial.projectId));
    if (
      project === undefined ||
      project.initialProjectTargetSelectorMappingId !== initial.projectTargetSelectorMappingId ||
      project.initialWorkspaceSelectorId !== initial.workspaceSelectorId
    ) {
      throw new HostStateRepositoryPersistenceError(
        "selector mapping chain is not the project initial selector",
      );
    }
    for (let index = 0; index < chain.length; index++) {
      const mapping = chain[index];
      if (
        mapping === undefined ||
        mapping.mappingGeneration !== index + 1 ||
        (index === chain.length - 1 ? mapping.state !== "current" : mapping.state !== "superseded")
      ) {
        throw new HostStateRepositoryPersistenceError(
          "selector mapping generations are not contiguous with one current tail",
        );
      }
      if (mapping.mappingGeneration > 1) {
        expectJournalCorrelation(
          mapping.collaborationServerId,
          "project_target_mapping_replaced",
          mapping.projectTargetSelectorMappingId,
        );
        const replacement = loadMappingReplacement(
          transaction,
          mapping.collaborationServerId,
          mapping.projectTargetSelectorMappingId,
        );
        if (
          replacement === null ||
          replacement.previousMapping.projectTargetSelectorMappingId !==
            chain[index - 1]?.projectTargetSelectorMappingId
        ) {
          throw new HostStateRepositoryPersistenceError(
            "selector mapping replacement chain is incomplete",
          );
        }
        const priorEntry =
          mapping.mappingGeneration === 2
            ? journalBySubject.get(
                `${mapping.collaborationServerId}\0project_bootstrapped\0${mapping.projectId}`,
              )
            : journalBySubject.get(
                `${mapping.collaborationServerId}\0project_target_mapping_replaced\0${chain[index - 1]?.projectTargetSelectorMappingId ?? ""}`,
              );
        if (
          priorEntry === undefined ||
          replacement.journalEntry.journalOffset <= priorEntry.journalOffset
        ) {
          throw new HostStateRepositoryPersistenceError(
            "selector mapping replacement journal order is invalid",
          );
        }
      }
    }
  }
  for (const chat of chats) validateChatLinkage(transaction, chat, allowActivatedBinding);

  // Parent lineage is acyclic within one project/server scope.
  for (const chat of chats) {
    const seen = new Set<string>([chat.logicalChatId]);
    let cursor = chat.parentChatId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new HostStateRepositoryPersistenceError(
          "logical chat parent lineage contains a cycle",
        );
      }
      seen.add(cursor);
      const parent = chatById.get(key(chat.collaborationServerId, cursor));
      if (parent === undefined || parent.projectId !== chat.projectId) {
        throw new HostStateRepositoryPersistenceError("logical chat parent lineage is invalid");
      }
      cursor = parent.parentChatId;
    }
  }

  for (const binding of bindings) {
    const chat = chatById.get(key(binding.collaborationServerId, binding.logicalChatId));
    if (chat === undefined || chat.projectId !== binding.projectId) {
      throw new HostStateRepositoryPersistenceError("native binding chat linkage is invalid");
    }
    const mapping = mappingById.get(
      key(binding.collaborationServerId, chat.projectTargetSelectorMappingId),
    );
    if (
      mapping === undefined ||
      mapping.target.kind !== "terminal_native" ||
      !sameDescriptor(mapping.target.descriptor, binding.descriptor)
    ) {
      throw new HostStateRepositoryPersistenceError("native binding selector linkage is invalid");
    }
  }
  const intentsByBinding = new Map<string, NativeRegistrationIntentRecord[]>();
  const reservationJournalByChat = new Map<string, HostStateJournalEntry>();
  for (const intent of intents) {
    const binding = bindingById.get(key(intent.collaborationServerId, intent.nativeBindingId));
    if (binding === undefined) {
      throw new HostStateRepositoryPersistenceError("registration intent has no native binding");
    }
    const bindingKey = key(intent.collaborationServerId, intent.nativeBindingId);
    const bindingIntents = intentsByBinding.get(bindingKey) ?? [];
    bindingIntents.push(intent);
    intentsByBinding.set(bindingKey, bindingIntents);
    const graph = loadTerminalReservation(
      transaction,
      intent.collaborationServerId,
      intent.registrationAttemptId,
      allowActivatedBinding,
    );
    if (graph === null) {
      throw new HostStateRepositoryPersistenceError(
        "registration intent terminal graph is incomplete",
      );
    }
    const isFirst =
      graph.project.allocationKind === "first_bootstrap" &&
      graph.project.projectAllocationIntentId === intent.registrationAttemptId;
    if (
      (isFirst && graph.journalEntry.entryKind !== "project_bootstrapped") ||
      (!isFirst && graph.journalEntry.entryKind !== "terminal_chat_reserved")
    ) {
      throw new HostStateRepositoryPersistenceError(
        "terminal reservation has the wrong journal correlation",
      );
    }
    if (!isFirst) {
      expectJournalCorrelation(
        intent.collaborationServerId,
        "terminal_chat_reserved",
        graph.chat.logicalChatId,
      );
    }
    const bootstrap = journalBySubject.get(
      `${graph.project.collaborationServerId}\0project_bootstrapped\0${graph.project.projectId}`,
    );
    if (
      bootstrap === undefined ||
      (!isFirst && graph.journalEntry.journalOffset <= bootstrap.journalOffset)
    ) {
      throw new HostStateRepositoryPersistenceError(
        "terminal reservation journal precedes its project bootstrap",
      );
    }
    const mappingChain = mappingChains.get(
      `${graph.mapping.collaborationServerId}\0${graph.mapping.projectId}\0${graph.mapping.workspaceSelectorId}`,
    );
    const selectedMapping = mappingChain?.[graph.mapping.mappingGeneration - 1];
    if (
      selectedMapping === undefined ||
      selectedMapping.projectTargetSelectorMappingId !==
        graph.mapping.projectTargetSelectorMappingId
    ) {
      throw new HostStateRepositoryPersistenceError(
        "terminal reservation selector mapping chain is invalid",
      );
    }
    const mappingCreationEntry =
      graph.mapping.mappingGeneration === 1
        ? bootstrap
        : journalBySubject.get(
            `${graph.mapping.collaborationServerId}\0project_target_mapping_replaced\0${graph.mapping.projectTargetSelectorMappingId}`,
          );
    if (
      mappingCreationEntry === undefined ||
      (isFirst
        ? graph.journalEntry.journalOffset !== mappingCreationEntry.journalOffset
        : graph.journalEntry.journalOffset <= mappingCreationEntry.journalOffset)
    ) {
      throw new HostStateRepositoryPersistenceError(
        "terminal reservation journal does not follow its selected mapping",
      );
    }
    const successorMapping = mappingChain?.[graph.mapping.mappingGeneration];
    if (graph.mapping.state === "superseded") {
      const successorEntry =
        successorMapping === undefined
          ? undefined
          : journalBySubject.get(
              `${successorMapping.collaborationServerId}\0project_target_mapping_replaced\0${successorMapping.projectTargetSelectorMappingId}`,
            );
      if (
        successorEntry === undefined ||
        graph.journalEntry.journalOffset >= successorEntry.journalOffset
      ) {
        throw new HostStateRepositoryPersistenceError(
          "terminal reservation journal does not precede mapping supersession",
        );
      }
    } else if (successorMapping !== undefined) {
      throw new HostStateRepositoryPersistenceError(
        "current terminal reservation mapping has an unexpected successor",
      );
    }
    reservationJournalByChat.set(
      key(graph.chat.collaborationServerId, graph.chat.logicalChatId),
      graph.journalEntry,
    );
  }
  for (const chat of chats) {
    if (chat.parentChatId === null) continue;
    const childEntry = reservationJournalByChat.get(
      key(chat.collaborationServerId, chat.logicalChatId),
    );
    const parentEntry = reservationJournalByChat.get(
      key(chat.collaborationServerId, chat.parentChatId),
    );
    if (
      childEntry === undefined ||
      parentEntry === undefined ||
      childEntry.journalOffset <= parentEntry.journalOffset
    ) {
      throw new HostStateRepositoryPersistenceError(
        "child terminal reservation journal precedes its parent",
      );
    }
  }
  for (const binding of bindings) {
    if (
      (intentsByBinding.get(key(binding.collaborationServerId, binding.nativeBindingId)) ?? [])
        .length !== 1
    ) {
      throw new HostStateRepositoryPersistenceError(
        "native binding must have exactly one registration intent",
      );
    }
  }
  for (const edge of edges) {
    const chat = chatById.get(key(edge.representedServerId, edge.representedLogicalChatId));
    if (chat === undefined) {
      throw new HostStateRepositoryPersistenceError("inward edge has no represented logical chat");
    }
    const binding =
      edge.targetNativeBindingId === null
        ? undefined
        : bindingById.get(key(edge.representedServerId, edge.targetNativeBindingId));
    if (
      edge.targetKind !== "native-harness" ||
      binding === undefined ||
      binding.logicalChatId !== chat.logicalChatId ||
      chat.currentInwardEdgeId !== edge.inwardEdgeId ||
      edge.targetServerId !== null ||
      edge.targetLogicalChatId !== null ||
      edge.rootPathCertificateId !== null ||
      edge.currentConnectionEpoch !== 0 ||
      edge.currentLiveLeaseId !== null ||
      edge.currentCapabilitySnapshotId !== null ||
      edge.state !== "installing"
    ) {
      throw new HostStateRepositoryPersistenceError("terminal inward edge target is invalid");
    }
  }

  const leasesByServer = new Map<CollaborationServerId, CoordinatorLeaseRecord[]>();
  for (const lease of leases) {
    expectJournalCorrelation(
      lease.collaborationServerId,
      "coordinator_lease_acquired",
      lease.coordinatorLeaseId,
    );
    const server = serverById.get(lease.collaborationServerId);
    if (server === undefined || lease.coordinatorEpoch > server.currentCoordinatorEpoch) {
      throw new HostStateRepositoryPersistenceError("coordinator lease server epoch is invalid");
    }
    const acquired = journalBySubject.get(
      `${lease.collaborationServerId}\0coordinator_lease_acquired\0${lease.coordinatorLeaseId}`,
    );
    if (
      acquired === undefined ||
      acquired.coordinatorLeaseId !== lease.coordinatorLeaseId ||
      acquired.coordinatorEpoch !== lease.coordinatorEpoch ||
      acquired.committedAtMs !== lease.acquiredAtMs
    ) {
      throw new HostStateRepositoryPersistenceError("coordinator acquisition journal is invalid");
    }
    const released = journalBySubject.get(
      `${lease.collaborationServerId}\0coordinator_lease_released\0${lease.coordinatorLeaseId}`,
    );
    if (lease.state === "released") {
      expectJournalCorrelation(
        lease.collaborationServerId,
        "coordinator_lease_released",
        lease.coordinatorLeaseId,
      );
      if (
        released === undefined ||
        lease.releasedAtMs === null ||
        released.committedAtMs !== lease.releasedAtMs
      ) {
        throw new HostStateRepositoryPersistenceError("coordinator release journal is invalid");
      }
    } else if (released !== undefined || lease.releasedAtMs !== null) {
      throw new HostStateRepositoryPersistenceError(
        "unreleased coordinator lease has release evidence",
      );
    }
    const serverLeases = leasesByServer.get(lease.collaborationServerId) ?? [];
    serverLeases.push(lease);
    leasesByServer.set(lease.collaborationServerId, serverLeases);
  }
  for (const server of servers) {
    const serverLeases = leasesByServer.get(server.collaborationServerId) ?? [];
    if (serverLeases.length !== server.currentCoordinatorEpoch) {
      throw new HostStateRepositoryPersistenceError(
        "coordinator lease epochs are not a complete history",
      );
    }
    for (let index = 0; index < serverLeases.length; index++) {
      const lease = serverLeases[index];
      if (lease?.coordinatorEpoch !== index + 1) {
        throw new HostStateRepositoryPersistenceError(
          "coordinator lease epochs are not contiguous",
        );
      }
      const predecessor = serverLeases[index - 1];
      if (predecessor !== undefined) {
        const predecessorAcquisition = journalBySubject.get(
          `${predecessor.collaborationServerId}\0coordinator_lease_acquired\0${predecessor.coordinatorLeaseId}`,
        );
        const successorAcquisition = journalBySubject.get(
          `${lease.collaborationServerId}\0coordinator_lease_acquired\0${lease.coordinatorLeaseId}`,
        );
        if (
          predecessorAcquisition === undefined ||
          successorAcquisition === undefined ||
          successorAcquisition.journalOffset <= predecessorAcquisition.journalOffset
        ) {
          throw new HostStateRepositoryPersistenceError(
            "coordinator acquisition journal order is invalid",
          );
        }
        if (predecessor.state === "released") {
          const release = journalBySubject.get(
            `${predecessor.collaborationServerId}\0coordinator_lease_released\0${predecessor.coordinatorLeaseId}`,
          );
          if (
            predecessor.releasedAtMs === null ||
            lease.acquiredAtMs < predecessor.releasedAtMs ||
            release === undefined ||
            release.journalOffset >= successorAcquisition.journalOffset
          ) {
            throw new HostStateRepositoryPersistenceError(
              "coordinator successor does not follow its released predecessor",
            );
          }
        } else if (lease.acquiredAtMs < predecessor.heartbeatDeadlineMs) {
          throw new HostStateRepositoryPersistenceError(
            "coordinator successor was acquired before its predecessor expired",
          );
        }
      }
    }
    if (server.currentCoordinatorEpoch === 0) {
      if (server.currentCoordinatorLeaseId !== null) {
        throw new HostStateRepositoryPersistenceError(
          "zero coordinator epoch has a current lease pointer",
        );
      }
    } else {
      const latest = serverLeases.at(-1);
      if (latest === undefined) {
        throw new HostStateRepositoryPersistenceError("current coordinator epoch has no lease");
      }
      if (server.currentCoordinatorLeaseId === null) {
        if (latest.state !== "released" || latest.releasedAtMs === null) {
          throw new HostStateRepositoryPersistenceError(
            "null coordinator pointer is not backed by the released current epoch",
          );
        }
      } else if (latest.coordinatorLeaseId !== server.currentCoordinatorLeaseId) {
        throw new HostStateRepositoryPersistenceError(
          "current coordinator pointer does not name the latest epoch",
        );
      }
    }
  }

  const journalByServer = new Map<CollaborationServerId, HostStateJournalEntry[]>();
  for (const entry of journal) {
    const server = serverById.get(entry.collaborationServerId);
    const lease = leaseById.get(key(entry.collaborationServerId, entry.coordinatorLeaseId));
    if (
      server === undefined ||
      lease === undefined ||
      lease.coordinatorEpoch !== entry.coordinatorEpoch ||
      entry.committedAtMs < lease.acquiredAtMs ||
      entry.committedAtMs >= lease.heartbeatDeadlineMs
    ) {
      throw new HostStateRepositoryPersistenceError("journal coordinator fence is invalid");
    }
    const acquisition = journalBySubject.get(
      `${entry.collaborationServerId}\0coordinator_lease_acquired\0${entry.coordinatorLeaseId}`,
    );
    const release = journalBySubject.get(
      `${entry.collaborationServerId}\0coordinator_lease_released\0${entry.coordinatorLeaseId}`,
    );
    if (
      acquisition === undefined ||
      (entry.entryKind !== "coordinator_lease_acquired" &&
        entry.journalOffset <= acquisition.journalOffset) ||
      (release !== undefined &&
        entry.entryKind !== "coordinator_lease_released" &&
        entry.journalOffset >= release.journalOffset)
    ) {
      throw new HostStateRepositoryPersistenceError(
        "control journal entry is outside its coordinator lease interval",
      );
    }
    if (entry.entryKind === "project_bootstrapped") {
      if (
        entry.subjectKind !== "project" ||
        !projectById.has(key(entry.collaborationServerId, entry.subjectId))
      ) {
        throw new HostStateRepositoryPersistenceError("project journal subject is invalid");
      }
    } else if (entry.entryKind === "terminal_chat_reserved") {
      if (
        entry.subjectKind !== "logical_chat" ||
        !chatById.has(key(entry.collaborationServerId, entry.subjectId))
      ) {
        throw new HostStateRepositoryPersistenceError("chat journal subject is invalid");
      }
    } else if (entry.entryKind === "project_target_mapping_replaced") {
      const mapping = mappingById.get(key(entry.collaborationServerId, entry.subjectId));
      if (
        entry.subjectKind !== "project_target_mapping" ||
        mapping === undefined ||
        mapping.mappingGeneration <= 1
      ) {
        throw new HostStateRepositoryPersistenceError(
          "project target mapping journal subject is invalid",
        );
      }
    } else if (
      entry.subjectKind !== "coordinator_lease" ||
      entry.subjectId !== entry.coordinatorLeaseId
    ) {
      throw new HostStateRepositoryPersistenceError("coordinator journal subject is invalid");
    }
    const entries = journalByServer.get(entry.collaborationServerId) ?? [];
    entries.push(entry);
    journalByServer.set(entry.collaborationServerId, entries);
  }
  if (
    expectedJournalCorrelations.size !== journal.length ||
    journal.some(
      (entry) =>
        !expectedJournalCorrelations.has(
          `${entry.collaborationServerId}\0${entry.entryKind}\0${entry.subjectId}`,
        ),
    )
  ) {
    throw new HostStateRepositoryPersistenceError(
      "control journal does not exactly cover the durable host graph",
    );
  }
  for (const server of servers) {
    const entries = journalByServer.get(server.collaborationServerId) ?? [];
    if (entries.length !== server.nextJournalOffset) {
      throw new HostStateRepositoryPersistenceError("control journal offset range is incomplete");
    }
    for (let offset = 0; offset < entries.length; offset++) {
      if (entries[offset]?.journalOffset !== offset) {
        throw new HostStateRepositoryPersistenceError("control journal offsets are not contiguous");
      }
    }
  }
}

/**
 * Bind the same high-level repository operations to an existing outer A1.1
 * transaction. This permits protected artifacts and A1.2 records to commit
 * atomically without nesting or exposing the SQL transaction to callers.
 */
export function createHostStateRepositoryTransactionOperations(
  transaction: HostStateRepositorySqlTransaction,
  machineIdentityId: string,
  options: HostStateRepositoryOptions = {},
): HostStateRepositoryOperations {
  return new HostStateRepository(
    {
      transaction: <T>(operation: (active: HostStateRepositorySqlTransaction) => T): T =>
        operation(transaction),
    },
    machineIdentityId,
    options,
  );
}
