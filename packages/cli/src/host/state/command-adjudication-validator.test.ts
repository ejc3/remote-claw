import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
  A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
  A1_COMMAND_DECISION_POLICY_ID,
  A1_COMMAND_RESULT_SCHEMA_ID,
  A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
  base64urlEncode,
  canonicalA1CollaborationCommandIdPreimage,
  canonicalA1CommandDecisionEvidence,
  canonicalA1CommandPayload,
  canonicalA1CommandRecord,
  canonicalA1CommandResultPayload,
  canonicalA1CommandSourceIdentity,
  canonicalA1ResultDeliveryIdPreimage,
  canonicalA1SignedCommandResult,
  canonicalA1StoredSemanticResultPreimage,
  encodeA1RejectedChatCreationResultPayloadV1Bytes,
} from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  deriveCollaborationCommandCompoundSigningGroupId,
  deriveCollaborationCommandResultId,
  deriveCollaborationCommandResultPreparationId,
} from "./command-adjudication.js";
import { validateCommandAdjudicationRepositorySnapshot } from "./command-adjudication-validator.js";
import { parseA1CanonicalId, parseA1SafeId } from "./ids.js";
import type { HostStateRepositorySqlTransaction } from "./repository.js";

const MACHINE_ID = "0".repeat(32);

function encoded(length: number, fill: number): string {
  return base64urlEncode(new Uint8Array(length).fill(fill));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function canonicalDigest(operation: () => Uint8Array): string {
  const bytes = operation();
  try {
    return digest(bytes);
  } finally {
    bytes.fill(0);
  }
}

interface Fixture {
  readonly transaction: HostStateRepositorySqlTransaction;
  readonly tables: Record<string, Array<Record<string, unknown>>>;
  readonly ids: Readonly<{
    serverId: string;
    commandId: string;
    resultId: string;
    preparationId: string;
  }>;
}

function signedFixture(): Fixture {
  const serverId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
  const coordinatorLeaseId = `rccl_${encoded(16, 2)}`;
  const routeId = `rcr_${encoded(32, 3)}`;
  const sourceResultId = `rrs_${encoded(32, 4)}`;
  const namespaceId = `wns_${encoded(32, 5)}`;
  const signingLeaseId = "server-signing-lease-1";
  const identityKeyId = "server-key-1";
  const certificateId = "server-cert-1";
  const messageDigest = encoded(32, 6);
  const fingerprint = encoded(32, 7);
  const createdAtMs = 10;
  const decidedAtMs = 20;
  const boundAtMs = 21;
  const signedAtMs = 22;

  const sourceBytes = canonicalA1CommandSourceIdentity({
    sourceKind: "a1_ingress",
    identityId: Buffer.from(MACHINE_ID, "hex"),
    collaborationServerId: serverId,
    scopeKind: "server_control",
    logicalChatId: null,
    sourceEventNamespaceId: namespaceId,
    sourceEventId: "message-1",
  });
  const sourceDigest = digest(sourceBytes);
  sourceBytes.fill(0);
  const commandIdBytes = canonicalA1CollaborationCommandIdPreimage({
    collaborationServerId: serverId,
    sourceKind: "a1_ingress",
    sourceCommandIdentityDigest: sourceDigest,
  });
  const commandId = parseA1SafeId(`rcm_${digest(commandIdBytes)}`);
  commandIdBytes.fill(0);

  const commandPayloadBytes = canonicalA1CommandPayload({
    schemaVersion: 1,
    canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    normalizedMutationFamily: "new_chat",
    sourcePayloadSchemaId: "remote-claw/a1-ingress-new-chat/v1",
    sourcePayloadDigest: messageDigest,
    sourceEventFingerprint: fingerprint,
  });
  const commandPayloadDigest = digest(commandPayloadBytes);
  const commandPayloadRef = `rcph_${encoded(16, 8)}`;

  const decisionBytes = canonicalA1CommandDecisionEvidence({
    schemaVersion: 1,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    commandId,
    collaborationServerId: serverId,
    scopeKind: "server_control",
    projectTargetSelectorMappingId: null,
    projectTargetSelectorMappingGeneration: null,
    projectTargetDigest: null,
    selectedTargetKind: null,
    selectedExecutorEvidenceSchemaId: null,
    selectedExecutorEvidenceRef: null,
    selectedExecutorEvidenceDigest: null,
    targetCapabilitySnapshotId: null,
    targetCapabilityFamilyDigest: null,
    decisionPolicyId: A1_COMMAND_DECISION_POLICY_ID,
  });
  const decisionDigest = digest(decisionBytes);
  const decisionRef = `rcph_${encoded(16, 9)}`;
  const commandRecord = {
    commandId,
    collaborationServerId: serverId,
    scopeKind: "server_control" as const,
    logicalChatId: null,
    targetLogicalChatId: null,
    sourceKind: "a1_ingress" as const,
    sourceRef: sourceResultId,
    sourceEventNamespaceId: namespaceId,
    sourceEventId: "message-1",
    sourceCommandIdentityDigest: sourceDigest,
    canonicalSourceEventDigest: null,
    mutationFamily: "new_chat" as const,
    canonicalCommandPayloadSchemaId: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
    canonicalCommandPayloadDigest: commandPayloadDigest,
    preDecisionNormalizationEvidenceSchemaId: null,
    preDecisionNormalizationEvidenceDigest: null,
    readyAtJournalSeq: 0,
    commandSeq: 0,
    disposition: "rejected" as const,
    admittedTargetKind: null,
    targetCapabilitySnapshotId: null,
    targetCapabilityFamilyDigest: null,
    decisionEvidenceSchemaId: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
    decisionEvidenceDigest: decisionDigest,
  };
  const commandRecordDigest = canonicalDigest(() => canonicalA1CommandRecord(commandRecord));
  const commandResultId = deriveCollaborationCommandResultId(serverId, commandId);
  const preparationId = deriveCollaborationCommandResultPreparationId({
    collaborationServerId: serverId,
    commandId,
    commandResultId,
    preparationGeneration: 1,
  });
  const groupId = deriveCollaborationCommandCompoundSigningGroupId({
    collaborationServerId: serverId,
    commandId,
    commandResultId,
    preparationGeneration: 1,
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const publicKeyValue = publicJwk.x as string;
  const resultBytes = canonicalA1CommandResultPayload({
    canonicalPayloadSchemaId: A1_COMMAND_RESULT_SCHEMA_ID,
    commandResultId,
    collaborationServerId: serverId,
    commandId,
    canonicalCommandRecordDigest: commandRecordDigest,
    resultVersion: 1,
    supersedesCommandResultId: null,
    sourceKind: "a1_ingress",
    sourceRef: sourceResultId,
    scopeKind: "server_control",
    logicalChatId: null,
    targetLogicalChatId: null,
    commandSeq: 0,
    disposition: "rejected",
    createdAtMs: decidedAtMs,
    signerSequence: 1,
    serverKeyGeneration: 1,
    signerIdentityKeyId: identityKeyId,
    signerScopeCertificateId: certificateId,
    signatureAlgorithm: "Ed25519",
  });
  const resultDigest = digest(resultBytes);
  const signature = base64urlEncode(sign(null, resultBytes, privateKey));
  const signedRecordDigest = canonicalDigest(() =>
    canonicalA1SignedCommandResult({
      canonicalPayloadDigest: resultDigest,
      signerIdentityKeyId: identityKeyId,
      serverKeyGeneration: 1,
      signerSequence: 1,
      signature,
    }),
  );
  const resultRef = `rcph_${encoded(16, 10)}`;

  const tables: Record<string, Array<Record<string, unknown>>> = {
    ready: [
      {
        collaboration_server_id: serverId,
        ready_at_journal_seq: 0,
        command_id: commandId,
        stable_semantic_result_id: sourceResultId,
        coordinator_lease_id: coordinatorLeaseId,
        coordinator_epoch: 1,
        ready_at_ms: createdAtMs,
      },
    ],
    adjudications: [
      {
        stable_semantic_result_id: sourceResultId,
        collaboration_server_id: serverId,
        command_id: commandId,
        ready_at_journal_seq: 0,
        command_seq: 0,
        disposition: "rejected",
        command_result_id: commandResultId,
        command_result_preparation_id: preparationId,
        viewer_projection_seq: null,
        decided_at_ms: decidedAtMs,
        terminal_at_ms: null,
        state: "deciding",
      },
    ],
    commands: [
      {
        command_id: commandId,
        collaboration_server_id: serverId,
        scope_kind: "server_control",
        logical_chat_id: null,
        target_logical_chat_id: null,
        source_kind: "a1_ingress",
        source_ref: sourceResultId,
        source_event_namespace_id: namespaceId,
        source_event_id: "message-1",
        source_command_identity_digest: sourceDigest,
        canonical_source_event_digest: null,
        mutation_family: "new_chat",
        canonical_command_payload_schema_id: A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
        canonical_command_payload_ref: commandPayloadRef,
        canonical_command_payload_digest: commandPayloadDigest,
        pre_decision_normalization_evidence_schema_id: null,
        pre_decision_normalization_evidence_ref: null,
        pre_decision_normalization_evidence_digest: null,
        ready_at_journal_seq: 0,
        command_seq: 0,
        disposition: "rejected",
        admitted_target_kind: null,
        project_target_selector_mapping_id: null,
        project_target_selector_mapping_generation: null,
        project_target_digest: null,
        selected_executor_evidence_schema_id: null,
        selected_executor_evidence_ref: null,
        selected_executor_evidence_digest: null,
        target_capability_snapshot_id: null,
        target_capability_family_digest: null,
        current_command_result_id: null,
        decision_evidence_schema_id: A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
        decision_evidence_ref: decisionRef,
        decision_evidence_digest: decisionDigest,
        canonical_command_record_digest: commandRecordDigest,
        coordinator_lease_id: coordinatorLeaseId,
        coordinator_epoch: 1,
        decision_coordinator_lease_id: coordinatorLeaseId,
        decision_coordinator_epoch: 1,
        created_at_ms: createdAtMs,
        decided_at_ms: decidedAtMs,
        state: "decision_reserved",
      },
    ],
    groups: [
      {
        compound_signing_group_id: groupId,
        collaboration_server_id: serverId,
        command_id: commandId,
        command_result_id: commandResultId,
        preparation_generation: 1,
        signing_lease_id: signingLeaseId,
        result_preparation_ref: preparationId,
        required_finalization_artifact_kind: "none",
        secondary_preparation_ref: null,
        reserved_at_ms: decidedAtMs,
        result_signed_at_ms: signedAtMs,
        both_signed_at_ms: null,
        finalized_at_ms: null,
        aborted_at_ms: null,
        state: "result_signed",
      },
    ],
    preparations: [
      {
        command_result_preparation_id: preparationId,
        command_result_id: commandResultId,
        collaboration_server_id: serverId,
        command_id: commandId,
        canonical_command_record_digest: commandRecordDigest,
        result_version: 1,
        preparation_generation: 1,
        supersedes_preparation_ref: null,
        canonical_payload_ref: resultRef,
        canonical_payload_digest: resultDigest,
        signer_sequence: 1,
        signing_lease_id: signingLeaseId,
        compound_signing_group_id: groupId,
        required_finalization_artifact_kind: "none",
        current_finalization_artifact_preparation_ref: null,
        prepared_at_ms: decidedAtMs,
        bound_at_ms: boundAtMs,
        signed_at_ms: signedAtMs,
        aborted_at_ms: null,
        state: "signed",
      },
    ],
    servers: [
      {
        collaboration_server_id: serverId,
        machine_identity_id: MACHINE_ID,
        next_journal_offset: 1,
        next_command_seq: 1,
        next_server_signature_seq: 2,
      },
    ],
    coordinators: [
      {
        collaboration_server_id: serverId,
        coordinator_lease_id: coordinatorLeaseId,
        coordinator_epoch: 1,
        acquired_at_ms: 1,
        heartbeat_deadline_ms: 1000,
        released_at_ms: null,
      },
    ],
    ingress: [
      {
        stable_semantic_result_id: sourceResultId,
        broker_route_id: routeId,
        collaboration_server_id: serverId,
        route_kind: "server_control",
        logical_chat_id: null,
        source_event_namespace_id: namespaceId,
        message_id: "message-1",
        record_kind: "new_chat",
        expected_parts: 1,
        accepted_delivery_attempt_id: `rda_${encoded(16, 11)}`,
        source_payload_schema_id: "remote-claw/a1-ingress-new-chat/v1",
        canonical_message_digest: messageDigest,
        source_event_fingerprint_schema_id: "remote-claw/a1/source-event-fingerprint/v1",
        source_event_fingerprint: fingerprint,
        state: "awaiting_order",
      },
    ],
    signingLeases: [
      {
        signing_lease_id: signingLeaseId,
        collaboration_server_id: serverId,
        identity_key_id: identityKeyId,
        key_generation: 1,
        scope_certificate_id: certificateId,
        coordinator_lease_id: coordinatorLeaseId,
        coordinator_epoch: 1,
        fencing_token: 1,
        acquired_at_ms: 5,
        draining_at_ms: null,
        superseded_at_ms: null,
        closed_at_ms: null,
        state: "current",
      },
    ],
    signingKeys: [
      {
        collaboration_server_id: serverId,
        identity_key_id: identityKeyId,
        key_generation: 1,
        public_key: publicKeyValue,
      },
    ],
    certificates: [
      {
        scope_certificate_id: certificateId,
        collaboration_server_id: serverId,
        subject_identity_key_id: identityKeyId,
        subject_public_key: publicKeyValue,
        key_generation: 1,
      },
    ],
    artifacts: [
      artifact(
        commandPayloadRef,
        serverId,
        A1_UNSUPPORTED_RECOGNIZED_COMMAND_PAYLOAD_SCHEMA_ID,
        commandPayloadBytes,
        createdAtMs,
      ),
      artifact(
        decisionRef,
        serverId,
        A1_COMMAND_DECISION_EVIDENCE_SCHEMA_ID,
        decisionBytes,
        decidedAtMs,
      ),
      artifact(resultRef, serverId, A1_COMMAND_RESULT_SCHEMA_ID, resultBytes, decidedAtMs),
    ],
    reservations: [
      reservation(serverId, 0, "bootstrap-lease-1", "bootstrap", "scope_certificate", 5),
      {
        collaboration_server_id: serverId,
        signer_sequence: 1,
        signing_lease_id: signingLeaseId,
        signing_lease_kind: "current",
        purpose: "collaboration_command_result",
        canonical_payload_schema_id: A1_COMMAND_RESULT_SCHEMA_ID,
        canonical_payload_ref: resultRef,
        canonical_payload_digest: resultDigest,
        signed_record_digest: signedRecordDigest,
        signature,
        signed_artifact_type: "collaboration_command_result_preparation",
        signed_artifact_id: preparationId,
        reserved_at_ms: decidedAtMs,
        bound_at_ms: boundAtMs,
        signed_at_ms: signedAtMs,
        aborted_at_ms: null,
        state: "signed",
      },
    ],
    routeScopes: [
      {
        broker_route_id: routeId,
        collaboration_server_id: serverId,
        route_kind: "server_control",
        logical_chat_id: null,
        machine_identity_id: MACHINE_ID,
        state: "current",
        active_gap_count: 0,
        updated_at_ms: 5,
        route_created_at_ms: 1,
      },
    ],
    routeHistory: [
      {
        stable_semantic_result_id: sourceResultId,
        broker_route_id: routeId,
        first_ingress_generation: 0,
        first_ingress_frame_index: 0,
      },
    ],
    gaps: [],
    acceptances: [],
    journal: [],
  };
  const transaction: HostStateRepositorySqlTransaction = {
    get: () => undefined,
    run: () => ({ changes: 0 }),
    all: (sql) => selectRows(tables, sql),
  };
  return {
    transaction,
    tables,
    ids: { serverId, commandId, resultId: commandResultId, preparationId },
  };
}

function finalizedFixture(): Fixture {
  const fixture = signedFixture();
  const command = fixture.tables.commands?.[0];
  const adjudication = fixture.tables.adjudications?.[0];
  const ingress = fixture.tables.ingress?.[0];
  const preparation = fixture.tables.preparations?.[0];
  const group = fixture.tables.groups?.[0];
  const signingLease = fixture.tables.signingLeases?.[0];
  const reservationRow = fixture.tables.reservations?.[1];
  if (
    command === undefined ||
    adjudication === undefined ||
    ingress === undefined ||
    preparation === undefined ||
    group === undefined ||
    signingLease === undefined ||
    reservationRow === undefined
  ) {
    throw new Error("signed fixture is incomplete");
  }

  const terminalAtMs = 30;
  const triggerObservationId = `rio_${encoded(32, 12)}`;
  const semanticPayloadRef = `rcph_${encoded(16, 13)}`;
  const semanticPayloadBytes = encodeA1RejectedChatCreationResultPayloadV1Bytes({
    v: 1,
    resultId: String(ingress.stable_semantic_result_id),
    sourceMsgId: String(ingress.message_id),
    decision: "rejected",
    targetLogicalChatId: null,
    commandSeq: Number(command.command_seq),
  });
  const semanticArtifactDigest = digest(semanticPayloadBytes);
  const storedSemanticResultDigest = canonicalDigest(() =>
    canonicalA1StoredSemanticResultPreimage({
      storedSemanticResultSchemaId: A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
      exactCompactUtf8Payload: semanticPayloadBytes,
    }),
  );
  const resultDeliveryId = `rrd_${canonicalDigest(() =>
    canonicalA1ResultDeliveryIdPreimage({
      ingressResultId: String(ingress.stable_semantic_result_id),
      triggerIngressObservationId: triggerObservationId,
    }),
  )}`;

  command.current_command_result_id = fixture.ids.resultId;
  command.state = "decided";
  adjudication.terminal_at_ms = terminalAtMs;
  adjudication.state = "terminal";
  fixture.tables.commonResults = [
    {
      command_result_id: fixture.ids.resultId,
      collaboration_server_id: fixture.ids.serverId,
      command_id: fixture.ids.commandId,
      canonical_command_record_digest: command.canonical_command_record_digest,
      result_version: 1,
      supersedes_command_result_id: null,
      source_kind: "a1_ingress",
      source_ref: command.source_ref,
      scope_kind: "server_control",
      logical_chat_id: null,
      target_logical_chat_id: null,
      command_seq: command.command_seq,
      disposition: "rejected",
      canonical_payload_schema_id: A1_COMMAND_RESULT_SCHEMA_ID,
      canonical_payload_ref: preparation.canonical_payload_ref,
      canonical_payload_digest: preparation.canonical_payload_digest,
      command_result_preparation_id: fixture.ids.preparationId,
      compound_signing_group_id: group.compound_signing_group_id,
      signer_sequence: preparation.signer_sequence,
      server_key_generation: signingLease.key_generation,
      signer_identity_key_id: signingLease.identity_key_id,
      signer_scope_certificate_id: signingLease.scope_certificate_id,
      signature_algorithm: "Ed25519",
      signature: reservationRow.signature,
      signed_record_digest: reservationRow.signed_record_digest,
      accepted_at_journal_seq: 1,
      created_at_ms: preparation.prepared_at_ms,
      finalized_at_ms: terminalAtMs,
    },
  ];
  fixture.tables.terminalResults = [
    {
      stable_semantic_result_id: ingress.stable_semantic_result_id,
      collaboration_server_id: fixture.ids.serverId,
      broker_route_id: ingress.broker_route_id,
      command_id: fixture.ids.commandId,
      command_result_id: fixture.ids.resultId,
      accepted_ingress_delivery_attempt_id: ingress.accepted_delivery_attempt_id,
      trigger_ingress_observation_id: triggerObservationId,
      initial_result_delivery_id: resultDeliveryId,
      semantic_result_record_kind: "chat_creation_result",
      semantic_result_payload_schema_id: A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
      semantic_result_payload_ref: semanticPayloadRef,
      semantic_result_payload_artifact_digest: semanticArtifactDigest,
      stored_semantic_result_digest: storedSemanticResultDigest,
      finalization_coordinator_lease_id: signingLease.coordinator_lease_id,
      finalization_coordinator_epoch: signingLease.coordinator_epoch,
      adjudication_state: "terminal",
      terminal_at_ms: terminalAtMs,
    },
  ];
  fixture.tables.resultDeliveries = [
    {
      result_delivery_id: resultDeliveryId,
      stable_semantic_result_id: ingress.stable_semantic_result_id,
      source_kind: "a1_ingress",
      source_ref: ingress.stable_semantic_result_id,
      command_result_id: fixture.ids.resultId,
      trigger_ingress_observation_id: triggerObservationId,
      broker_route_id: ingress.broker_route_id,
      target_kind: "a1_broker",
      target_ref: ingress.broker_route_id,
      delivery_attempt_id: `rda_${encoded(16, 14)}`,
      semantic_result_record_kind: "chat_creation_result",
      semantic_result_payload_schema_id: A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
      semantic_result_payload_ref: semanticPayloadRef,
      semantic_result_payload_artifact_digest: semanticArtifactDigest,
      stored_semantic_result_digest: storedSemanticResultDigest,
      state: "pending_seal",
      created_at_ms: terminalAtMs,
    },
  ];
  fixture.tables.acceptances = [
    {
      collaboration_server_id: fixture.ids.serverId,
      accepted_at_journal_seq: 1,
      signed_record_digest: reservationRow.signed_record_digest,
      signer_identity_key_id: signingLease.identity_key_id,
      signer_key_generation: signingLease.key_generation,
      signer_scope_certificate_id: signingLease.scope_certificate_id,
      signer_sequence: preparation.signer_sequence,
      accepted_at_ms: terminalAtMs,
      historical_reattestation_id: null,
    },
  ];
  fixture.tables.currentAuthorities = [
    {
      collaboration_server_id: fixture.ids.serverId,
      current_coordinator_lease_id: signingLease.coordinator_lease_id,
      current_coordinator_epoch: signingLease.coordinator_epoch,
      current_identity_key_id: signingLease.identity_key_id,
      current_key_generation: signingLease.key_generation,
      current_scope_certificate_id: signingLease.scope_certificate_id,
      server_state: "current",
      identity_key_state: "current",
      private_key_custody_state: "current",
      certificate_status: "current",
    },
  ];
  fixture.tables.observations = [
    {
      ingress_observation_id: triggerObservationId,
      stable_semantic_result_id: ingress.stable_semantic_result_id,
      delivery_attempt_id: ingress.accepted_delivery_attempt_id,
      broker_route_id: ingress.broker_route_id,
      collaboration_server_id: fixture.ids.serverId,
      route_kind: ingress.route_kind,
      logical_chat_id: ingress.logical_chat_id,
      channel_generation: 0,
      frame_index: 0,
      part: 0,
      parts: 1,
      disposition: "new_part",
    },
  ];
  fixture.tables.artifacts?.push(
    artifact(
      semanticPayloadRef,
      fixture.ids.serverId,
      A1_CHAT_CREATION_RESULT_PAYLOAD_SCHEMA_ID,
      semanticPayloadBytes,
      terminalAtMs,
    ),
  );
  semanticPayloadBytes.fill(0);
  return fixture;
}

function artifact(
  ref: string,
  serverId: string,
  schemaId: string,
  source: Uint8Array,
  createdAtMs: number,
): Record<string, unknown> {
  const bytes = new Uint8Array(source);
  return {
    protected_handle_id: ref,
    kind: "artifact",
    scope_kind: "collaboration_server",
    scope_id: serverId,
    artifact_schema_id: schemaId,
    artifact_digest: digest(bytes),
    byte_length: bytes.byteLength,
    artifact_bytes: bytes,
    created_at_ms: createdAtMs,
  };
}

function reservation(
  serverId: string,
  sequence: number,
  leaseId: string,
  kind: "current" | "bootstrap",
  purpose: string,
  reservedAtMs: number,
): Record<string, unknown> {
  return {
    collaboration_server_id: serverId,
    signer_sequence: sequence,
    signing_lease_id: leaseId,
    signing_lease_kind: kind,
    purpose,
    canonical_payload_schema_id: null,
    canonical_payload_ref: null,
    canonical_payload_digest: null,
    signed_record_digest: null,
    signature: null,
    signed_artifact_type: null,
    signed_artifact_id: null,
    reserved_at_ms: reservedAtMs,
    bound_at_ms: null,
    signed_at_ms: null,
    aborted_at_ms: null,
    state: "reserved",
  };
}

function selectRows(
  tables: Record<string, Array<Record<string, unknown>>>,
  sql: string,
): readonly unknown[] {
  if (sql.includes("FROM command_ready_entries")) return tables.ready ?? [];
  if (sql.includes("FROM authenticated_ingress_observations AS observation"))
    return tables.observations ?? [];
  if (sql.includes("identity_key.state AS identity_key_state"))
    return tables.currentAuthorities ?? [];
  if (sql.includes("FROM collaboration_command_results\n")) return tables.commonResults ?? [];
  if (sql.includes("FROM a1_ingress_terminal_results\n")) return tables.terminalResults ?? [];
  if (sql.includes("FROM a1_ingress_result_deliveries\n")) return tables.resultDeliveries ?? [];
  if (sql.includes("first_ingress_generation")) return tables.routeHistory ?? [];
  if (sql.includes("FROM broker_route_runtime_status")) return tables.routeScopes ?? [];
  if (sql.includes("FROM broker_route_gaps")) return tables.gaps ?? [];
  if (sql.includes("FROM authenticated_ingress_results")) return tables.ingress ?? [];
  if (sql.includes("FROM a1_ingress_adjudications")) return tables.adjudications ?? [];
  if (sql.includes("FROM collaboration_commands")) return tables.commands ?? [];
  if (sql.includes("FROM collaboration_command_compound_signing_groups"))
    return tables.groups ?? [];
  if (sql.includes("FROM collaboration_command_result_preparations"))
    return tables.preparations ?? [];
  if (sql.includes("FROM collaboration_servers")) return tables.servers ?? [];
  if (sql.includes("FROM coordinator_leases")) return tables.coordinators ?? [];
  if (sql.includes("FROM server_signing_leases")) return tables.signingLeases ?? [];
  if (sql.includes("FROM server_identity_keys")) return tables.signingKeys ?? [];
  if (sql.includes("FROM server_scope_certificates")) return tables.certificates ?? [];
  if (sql.includes("FROM protected_artifacts")) return tables.artifacts ?? [];
  if (sql.includes("FROM server_signed_record_acceptances")) return tables.acceptances ?? [];
  if (sql.includes("FROM server_signature_reservations")) return tables.reservations ?? [];
  if (sql.includes("FROM control_journal_entries")) return tables.journal ?? [];
  throw new Error(`unexpected validator query: ${sql}`);
}

function validate(fixture: Fixture): void {
  validateCommandAdjudicationRepositorySnapshot(fixture.transaction, MACHINE_ID, 10);
}

function validateV11(fixture: Fixture): void {
  validateCommandAdjudicationRepositorySnapshot(fixture.transaction, MACHINE_ID, 11);
}

function addReservedReplacement(fixture: Fixture): string {
  const firstPreparation = fixture.tables.preparations?.[0];
  const firstGroup = fixture.tables.groups?.[0];
  const firstReservation = fixture.tables.reservations?.[1];
  const command = fixture.tables.commands?.[0];
  const adjudication = fixture.tables.adjudications?.[0];
  const signingLease = fixture.tables.signingLeases?.[0];
  const server = fixture.tables.servers?.[0];
  if (
    firstPreparation === undefined ||
    firstGroup === undefined ||
    firstReservation === undefined ||
    command === undefined ||
    adjudication === undefined ||
    signingLease === undefined ||
    server === undefined
  ) {
    throw new Error("signed fixture is incomplete");
  }
  firstPreparation.signed_at_ms = null;
  firstPreparation.aborted_at_ms = 23;
  firstPreparation.state = "aborted";
  firstGroup.result_signed_at_ms = null;
  firstGroup.aborted_at_ms = 23;
  firstGroup.state = "aborted";
  firstReservation.signed_record_digest = null;
  firstReservation.signature = null;
  firstReservation.signed_at_ms = null;
  firstReservation.aborted_at_ms = 23;
  firstReservation.state = "aborted";

  const generation = 2;
  const preparedAtMs = 30;
  const resultId = parseA1SafeId(firstPreparation.command_result_id);
  const serverId = parseA1CanonicalId("collaborationServer", fixture.ids.serverId);
  const commandId = parseA1SafeId(fixture.ids.commandId);
  const preparationId = deriveCollaborationCommandResultPreparationId({
    collaborationServerId: serverId,
    commandId,
    commandResultId: resultId,
    preparationGeneration: generation,
  });
  const groupId = deriveCollaborationCommandCompoundSigningGroupId({
    collaborationServerId: serverId,
    commandId,
    commandResultId: resultId,
    preparationGeneration: generation,
  });
  const resultBytes = canonicalA1CommandResultPayload({
    canonicalPayloadSchemaId: A1_COMMAND_RESULT_SCHEMA_ID,
    commandResultId: resultId,
    collaborationServerId: fixture.ids.serverId,
    commandId: fixture.ids.commandId,
    canonicalCommandRecordDigest: String(command.canonical_command_record_digest),
    resultVersion: 1,
    supersedesCommandResultId: null,
    sourceKind: "a1_ingress",
    sourceRef: String(command.source_ref),
    scopeKind: "server_control",
    logicalChatId: null,
    targetLogicalChatId: null,
    commandSeq: 0,
    disposition: "rejected",
    createdAtMs: preparedAtMs,
    signerSequence: 2,
    serverKeyGeneration: Number(signingLease.key_generation),
    signerIdentityKeyId: String(signingLease.identity_key_id),
    signerScopeCertificateId: String(signingLease.scope_certificate_id),
    signatureAlgorithm: "Ed25519",
  });
  const resultRef = `rcph_${encoded(16, 31)}`;
  fixture.tables.artifacts?.push(
    artifact(
      resultRef,
      fixture.ids.serverId,
      A1_COMMAND_RESULT_SCHEMA_ID,
      resultBytes,
      preparedAtMs,
    ),
  );
  fixture.tables.reservations?.push(
    reservation(
      fixture.ids.serverId,
      2,
      String(signingLease.signing_lease_id),
      "current",
      "collaboration_command_result",
      preparedAtMs,
    ),
  );
  fixture.tables.groups?.push({
    compound_signing_group_id: groupId,
    collaboration_server_id: fixture.ids.serverId,
    command_id: fixture.ids.commandId,
    command_result_id: resultId,
    preparation_generation: generation,
    signing_lease_id: signingLease.signing_lease_id,
    result_preparation_ref: preparationId,
    required_finalization_artifact_kind: "none",
    secondary_preparation_ref: null,
    reserved_at_ms: preparedAtMs,
    result_signed_at_ms: null,
    both_signed_at_ms: null,
    finalized_at_ms: null,
    aborted_at_ms: null,
    state: "reserved",
  });
  fixture.tables.preparations?.push({
    command_result_preparation_id: preparationId,
    command_result_id: resultId,
    collaboration_server_id: fixture.ids.serverId,
    command_id: fixture.ids.commandId,
    canonical_command_record_digest: command.canonical_command_record_digest,
    result_version: 1,
    preparation_generation: generation,
    supersedes_preparation_ref: fixture.ids.preparationId,
    canonical_payload_ref: resultRef,
    canonical_payload_digest: digest(resultBytes),
    signer_sequence: 2,
    signing_lease_id: signingLease.signing_lease_id,
    compound_signing_group_id: groupId,
    required_finalization_artifact_kind: "none",
    current_finalization_artifact_preparation_ref: null,
    prepared_at_ms: preparedAtMs,
    bound_at_ms: null,
    signed_at_ms: null,
    aborted_at_ms: null,
    state: "reserved",
  });
  adjudication.command_result_preparation_id = preparationId;
  server.next_server_signature_seq = 3;
  resultBytes.fill(0);
  return preparationId;
}

describe("command adjudication snapshot validator", () => {
  it("accepts a complete signed-but-unaccepted rejected result graph", () => {
    validate(signedFixture());
  });

  it.each([
    [0, "low"],
    [2, "high"],
  ])("rejects a %s nextCommandSeq counter", (nextCommandSeq) => {
    const fixture = signedFixture();
    const server = fixture.tables.servers?.[0];
    if (server !== undefined) server.next_command_seq = nextCommandSeq;
    expect(() => validate(fixture)).toThrow(/server command sequence is high, low, gapped/);
  });

  it("rejects a swapped command source", () => {
    const fixture = signedFixture();
    const command = fixture.tables.commands?.[0];
    if (command !== undefined) command.source_ref = `rrs_${encoded(32, 99)}`;
    expect(() => validate(fixture)).toThrow(/ready\/source\/sidecar graph is partial or swapped/);
  });

  it("rejects corrupt canonical artifact bytes", () => {
    const fixture = signedFixture();
    const stored = fixture.tables.artifacts?.[0]?.artifact_bytes;
    if (stored instanceof Uint8Array) stored[0] = (stored[0] ?? 0) ^ 1;
    expect(() => validate(fixture)).toThrow(/known command artifact digest is invalid/);
  });

  it("rejects a canonical artifact digest swapped with self-consistent foreign bytes", () => {
    const fixture = signedFixture();
    const commandArtifact = fixture.tables.artifacts?.[0];
    if (commandArtifact !== undefined) {
      const foreign = new Uint8Array([1, 2, 3, 4]);
      commandArtifact.artifact_bytes = foreign;
      commandArtifact.byte_length = foreign.byteLength;
      commandArtifact.artifact_digest = digest(foreign);
    }
    expect(() => validate(fixture)).toThrow(/artifact coordinates or digest are inconsistent/);
  });

  it("rejects a stale decision fence", () => {
    const fixture = signedFixture();
    const command = fixture.tables.commands?.[0];
    if (command !== undefined) command.decision_coordinator_epoch = 2;
    expect(() => validate(fixture)).toThrow(/command decision has no exact coordinator history/);
  });

  it("rejects a command result signature that does not verify", () => {
    const fixture = signedFixture();
    const commandReservation = fixture.tables.reservations?.[1];
    if (commandReservation !== undefined) commandReservation.signature = encoded(64, 42);
    expect(() => validate(fixture)).toThrow(/signature does not verify under the reserved key/);
  });

  it("rejects an orphan known-v10 artifact", () => {
    const fixture = signedFixture();
    fixture.tables.artifacts?.push(
      artifact(
        `rcph_${encoded(16, 77)}`,
        fixture.ids.serverId,
        A1_COMMAND_RESULT_SCHEMA_ID,
        new Uint8Array([1, 2, 3]),
        20,
      ),
    );
    expect(() => validate(fixture)).toThrow(/protected artifact is orphaned/);
  });

  it("rejects a materialized source that bypasses an earlier route head", () => {
    const fixture = signedFixture();
    const source = fixture.tables.routeHistory?.[0];
    if (source !== undefined) source.first_ingress_frame_index = 1;
    fixture.tables.routeHistory?.unshift({
      stable_semantic_result_id: `rrs_${encoded(32, 88)}`,
      broker_route_id: fixture.tables.routeScopes?.[0]?.broker_route_id,
      first_ingress_generation: 0,
      first_ingress_frame_index: 0,
    });
    expect(() => validate(fixture)).toThrow(/bypassed an earlier unadjudicated route head/);
  });

  it("rejects a command decision observed inside an open route-gap interval", () => {
    const fixture = signedFixture();
    fixture.tables.gaps?.push({
      broker_route_id: fixture.tables.routeScopes?.[0]?.broker_route_id,
      opened_at_ms: 15,
      resolved_at_ms: 25,
    });
    expect(() => validate(fixture)).toThrow(/inside an open source-route gap interval/);
  });

  it("rejects command creation observed inside an open route-gap interval", () => {
    const fixture = signedFixture();
    fixture.tables.gaps?.push({
      broker_route_id: fixture.tables.routeScopes?.[0]?.broker_route_id,
      opened_at_ms: 5,
      resolved_at_ms: 15,
    });
    expect(() => validate(fixture)).toThrow(/command creation was observed inside/);
  });

  it("allows a command timestamp equal to a later gap opening", () => {
    const fixture = signedFixture();
    fixture.tables.gaps?.push({
      broker_route_id: fixture.tables.routeScopes?.[0]?.broker_route_id,
      opened_at_ms: 10,
      resolved_at_ms: 15,
    });
    validate(fixture);
  });

  it("does not merge two gaps that touch at the command timestamp", () => {
    const fixture = signedFixture();
    fixture.tables.gaps?.push(
      {
        broker_route_id: fixture.tables.routeScopes?.[0]?.broker_route_id,
        opened_at_ms: 5,
        resolved_at_ms: 10,
      },
      {
        broker_route_id: fixture.tables.routeScopes?.[0]?.broker_route_id,
        opened_at_ms: 10,
        resolved_at_ms: 15,
      },
    );
    validate(fixture);
  });

  it("rejects command creation before the immutable source route", () => {
    const fixture = signedFixture();
    const route = fixture.tables.routeScopes?.[0];
    if (route !== undefined) route.route_created_at_ms = 11;
    expect(() => validate(fixture)).toThrow(/source machine\/server\/route scope/);
  });

  it("rejects a command lifecycle that postdates a closed source route", () => {
    const fixture = signedFixture();
    const route = fixture.tables.routeScopes?.[0];
    if (route !== undefined) {
      route.state = "closed";
      route.updated_at_ms = 19;
    }
    expect(() => validate(fixture)).toThrow(/postdates the closed source route/);
  });

  it("rejects a command decision that predates command creation", () => {
    const fixture = signedFixture();
    const command = fixture.tables.commands?.[0];
    if (command !== undefined) command.created_at_ms = 21;
    expect(() => validate(fixture)).toThrow(/collaboration command is invalid/);
  });

  it("rejects lifecycle time after signing-lease authority ended", () => {
    const fixture = signedFixture();
    const lease = fixture.tables.signingLeases?.[0];
    if (lease !== undefined) {
      lease.draining_at_ms = 19;
      lease.state = "draining";
    }
    expect(() => validate(fixture)).toThrow(/reservation postdates its signing lease authority/);
  });

  it("accepts a contiguous aborted generation followed by a reserved replacement", () => {
    const fixture = signedFixture();
    addReservedReplacement(fixture);
    validate(fixture);
  });

  it("rejects a broken replacement supersession chain", () => {
    const fixture = signedFixture();
    addReservedReplacement(fixture);
    const replacement = fixture.tables.preparations?.[1];
    if (replacement !== undefined) {
      replacement.supersedes_preparation_ref = `crp_${encoded(32, 89)}`;
    }
    expect(() => validate(fixture)).toThrow(/generation graph is noncanonical/);
  });

  it("scrubs prior and failing artifact rows when a later artifact is malformed", () => {
    const fixture = signedFixture();
    const first = fixture.tables.artifacts?.[0]?.artifact_bytes;
    const second = fixture.tables.artifacts?.[1]?.artifact_bytes;
    const secondArtifact = fixture.tables.artifacts?.[1];
    if (secondArtifact !== undefined) secondArtifact.protected_handle_id = "not-a-handle";
    expect(() => validate(fixture)).toThrow();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(second).toBeInstanceOf(Uint8Array);
    expect([...(first as Uint8Array)]).toEqual(new Array((first as Uint8Array).byteLength).fill(0));
    expect([...(second as Uint8Array)]).toEqual(
      new Array((second as Uint8Array).byteLength).fill(0),
    );
  });

  it("accepts one exact rejected-only schema-v11 final result graph", () => {
    validateV11(finalizedFixture());
  });

  it("selects the lexicographically greatest completion cursor, not the greatest part", () => {
    const fixture = finalizedFixture();
    const ingress = fixture.tables.ingress?.[0];
    const first = fixture.tables.observations?.[0];
    if (ingress === undefined || first === undefined) {
      throw new Error("finalized fixture is incomplete");
    }
    ingress.expected_parts = 2;
    first.channel_generation = 1;
    first.frame_index = 0;
    first.part = 0;
    first.parts = 2;
    fixture.tables.observations?.push({
      ...first,
      ingress_observation_id: `rio_${encoded(32, 39)}`,
      channel_generation: 0,
      frame_index: 10,
      part: 1,
    });
    validateV11(fixture);
  });

  it("retains semantic finalization after a later source collision and route closure", () => {
    const fixture = finalizedFixture();
    const ingress = fixture.tables.ingress?.[0];
    const route = fixture.tables.routeScopes?.[0];
    if (ingress !== undefined) ingress.state = "quarantined_collision";
    if (route !== undefined) {
      route.state = "closed";
      route.active_gap_count = 1;
      route.updated_at_ms = 25;
    }
    fixture.tables.gaps?.push({
      broker_route_id: route?.broker_route_id,
      opened_at_ms: 25,
      resolved_at_ms: null,
    });
    validateV11(fixture);
  });

  it("accepts only the max-fence signed predecessor under a live successor takeover", () => {
    const fixture = finalizedFixture();
    const predecessor = fixture.tables.signingLeases?.[0];
    const terminal = fixture.tables.terminalResults?.[0];
    const authority = fixture.tables.currentAuthorities?.[0];
    if (predecessor === undefined || terminal === undefined || authority === undefined) {
      throw new Error("finalized fixture is incomplete");
    }
    predecessor.superseded_at_ms = 25;
    predecessor.state = "superseded";
    const predecessorCoordinator = fixture.tables.coordinators?.[0];
    if (predecessorCoordinator !== undefined) predecessorCoordinator.released_at_ms = 25;
    fixture.tables.coordinators?.push({
      collaboration_server_id: fixture.ids.serverId,
      coordinator_lease_id: `rccl_${encoded(16, 40)}`,
      coordinator_epoch: 2,
      acquired_at_ms: 25,
      heartbeat_deadline_ms: 1000,
      released_at_ms: null,
    });
    const successor = fixture.tables.coordinators?.[1];
    terminal.finalization_coordinator_lease_id = successor?.coordinator_lease_id;
    terminal.finalization_coordinator_epoch = successor?.coordinator_epoch;
    authority.current_coordinator_lease_id = successor?.coordinator_lease_id;
    authority.current_coordinator_epoch = successor?.coordinator_epoch;
    validateV11(fixture);
  });

  it("rejects an equal-time higher signing fence as hostile ambiguity", () => {
    const fixture = finalizedFixture();
    const predecessor = fixture.tables.signingLeases?.[0];
    const terminal = fixture.tables.terminalResults?.[0];
    const authority = fixture.tables.currentAuthorities?.[0];
    if (predecessor === undefined || terminal === undefined || authority === undefined) {
      throw new Error("finalized fixture is incomplete");
    }
    predecessor.superseded_at_ms = 25;
    predecessor.state = "superseded";
    const predecessorCoordinator = fixture.tables.coordinators?.[0];
    if (predecessorCoordinator !== undefined) predecessorCoordinator.released_at_ms = 25;
    const successorCoordinatorId = `rccl_${encoded(16, 42)}`;
    fixture.tables.coordinators?.push({
      collaboration_server_id: fixture.ids.serverId,
      coordinator_lease_id: successorCoordinatorId,
      coordinator_epoch: 2,
      acquired_at_ms: 25,
      heartbeat_deadline_ms: 1000,
      released_at_ms: null,
    });
    terminal.finalization_coordinator_lease_id = successorCoordinatorId;
    terminal.finalization_coordinator_epoch = 2;
    authority.current_coordinator_lease_id = successorCoordinatorId;
    authority.current_coordinator_epoch = 2;
    fixture.tables.signingLeases?.push({
      ...predecessor,
      signing_lease_id: "post-acceptance-signing-lease",
      coordinator_lease_id: successorCoordinatorId,
      coordinator_epoch: 2,
      fencing_token: 2,
      acquired_at_ms: terminal.terminal_at_ms,
      draining_at_ms: null,
      superseded_at_ms: null,
      closed_at_ms: null,
      state: "current",
    });
    expect(() => validateV11(fixture)).toThrow(/narrow superseded-lease takeover repair/);
  });

  it("rejects takeover acceptance after a strictly earlier intervening higher signing fence", () => {
    const fixture = finalizedFixture();
    const predecessor = fixture.tables.signingLeases?.[0];
    const terminal = fixture.tables.terminalResults?.[0];
    if (predecessor === undefined || terminal === undefined) {
      throw new Error("finalized fixture is incomplete");
    }
    predecessor.superseded_at_ms = 25;
    predecessor.state = "superseded";
    const predecessorCoordinator = fixture.tables.coordinators?.[0];
    if (predecessorCoordinator !== undefined) predecessorCoordinator.released_at_ms = 25;
    const successorCoordinatorId = `rccl_${encoded(16, 41)}`;
    fixture.tables.coordinators?.push({
      collaboration_server_id: fixture.ids.serverId,
      coordinator_lease_id: successorCoordinatorId,
      coordinator_epoch: 2,
      acquired_at_ms: 25,
      heartbeat_deadline_ms: 1000,
      released_at_ms: null,
    });
    terminal.finalization_coordinator_lease_id = successorCoordinatorId;
    terminal.finalization_coordinator_epoch = 2;
    fixture.tables.signingLeases?.push({
      ...predecessor,
      signing_lease_id: "intervening-signing-lease",
      coordinator_lease_id: successorCoordinatorId,
      coordinator_epoch: 2,
      fencing_token: 2,
      acquired_at_ms: 26,
      draining_at_ms: null,
      superseded_at_ms: null,
      closed_at_ms: null,
      state: "current",
    });
    expect(() => validateV11(fixture)).toThrow(/narrow superseded-lease takeover repair/);
  });

  it.each([
    [
      "stored digest",
      (fixture: Fixture) => {
        const terminal = fixture.tables.terminalResults?.[0];
        if (terminal !== undefined) terminal.stored_semantic_result_digest = encoded(32, 90);
      },
    ],
    [
      "acceptance signer",
      (fixture: Fixture) => {
        const acceptance = fixture.tables.acceptances?.[0];
        if (acceptance !== undefined) acceptance.signer_identity_key_id = "foreign-key";
      },
    ],
    [
      "completion trigger",
      (fixture: Fixture) => {
        const terminal = fixture.tables.terminalResults?.[0];
        if (terminal !== undefined)
          terminal.trigger_ingress_observation_id = `rio_${encoded(32, 91)}`;
      },
    ],
    [
      "noncanonical random attempt",
      (fixture: Fixture) => {
        const delivery = fixture.tables.resultDeliveries?.[0];
        if (delivery !== undefined) delivery.delivery_attempt_id = `rda_${"A".repeat(21)}B`;
      },
    ],
  ] as const)("rejects a corrupt schema-v11 %s", (_label, corrupt) => {
    const fixture = finalizedFixture();
    corrupt(fixture);
    expect(() => validateV11(fixture)).toThrow();
  });
});
