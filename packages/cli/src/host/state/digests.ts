import {
  base64urlDecode,
  base64urlEncode,
  CanonicalWriter,
  sha256,
  timingSafeEqual,
} from "@remote-claw/clawsec";
import {
  type A1Digest,
  HostStateContractError,
  type ProjectTargetSelectorMappingId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "./ids.js";
import {
  type NativeRegistrationIntentRecord,
  type ProjectRecord,
  type ProjectTarget,
  type ProjectTargetSelectorMappingRecord,
  parseNativeRegistrationIntentRecord,
  parseProjectRecord,
  parseProjectTarget,
  parseProjectTargetSelectorMappingRecord,
} from "./records.js";
import { parseEnum, parseLiteral, parseNonEmptyString } from "./validation.js";

async function digest(writer: CanonicalWriter): Promise<A1Digest> {
  return parseA1Digest(base64urlEncode(await sha256(writer.finish())));
}

function digestBytes(value: unknown, field: string): Uint8Array {
  return base64urlDecode(parseA1Digest(value, field));
}

function equalDigest(a: A1Digest, b: A1Digest): boolean {
  return timingSafeEqual(digestBytes(a, "computedDigest"), digestBytes(b, "claimedDigest"));
}

/**
 * Exact selected-A1 project allocation intent digest.
 *
 * `createdAtMs`, the current row state, and the mapping record ID are deliberately excluded:
 * the allocation intent commits the stable replay identity and requested target. The mapping ID is
 * deterministically checked with the mapping record in A1.2.
 */
export async function projectAllocationIntentDigest(
  record: Pick<
    ProjectRecord,
    | "projectAllocationIntentSchemaId"
    | "projectAllocationIntentId"
    | "collaborationServerId"
    | "projectId"
    | "allocationKind"
    | "initialWorkspaceSelectorId"
    | "initialTargetDigest"
  >,
): Promise<A1Digest> {
  const schemaId = parseLiteral(
    record.projectAllocationIntentSchemaId,
    "remote-claw/project-allocation-intent/v1",
    "projectAllocationIntent.projectAllocationIntentSchemaId",
  );
  const allocationKind = parseEnum(
    record.allocationKind,
    ["first_bootstrap", "explicit_new_project"] as const,
    "projectAllocationIntent.allocationKind",
  );
  const intentId =
    allocationKind === "first_bootstrap"
      ? parseA1CanonicalId(
          "registrationAttempt",
          record.projectAllocationIntentId,
          "projectAllocationIntent.projectAllocationIntentId",
        )
      : parseA1SafeId(
          record.projectAllocationIntentId,
          "projectAllocationIntent.projectAllocationIntentId",
        );
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    record.collaborationServerId,
    "projectAllocationIntent.collaborationServerId",
  );
  const projectId = parseA1CanonicalId(
    "project",
    record.projectId,
    "projectAllocationIntent.projectId",
  );
  const workspaceSelectorId = parseA1SafeId(
    record.initialWorkspaceSelectorId,
    "projectAllocationIntent.initialWorkspaceSelectorId",
  );
  const targetDigest = parseA1Digest(
    record.initialTargetDigest,
    "projectAllocationIntent.initialTargetDigest",
  );
  const writer = new CanonicalWriter();
  writer.str(schemaId);
  writer.str(intentId);
  writer.str(collaborationServerId);
  writer.str(projectId);
  writer.str(allocationKind);
  writer.str(workspaceSelectorId);
  writer.bytes(digestBytes(targetDigest, "projectAllocationIntent.initialTargetDigest"));
  return digest(writer);
}

export async function verifyProjectAllocationIntentDigest(record: ProjectRecord): Promise<void> {
  const parsed = parseProjectRecord(record);
  const computed = await projectAllocationIntentDigest(parsed);
  if (!equalDigest(computed, parsed.projectAllocationIntentDigest)) {
    throw new HostStateContractError(
      "project.projectAllocationIntentDigest does not match its row",
    );
  }
}

/**
 * Exact selected-A1 durable native-registration intent.
 *
 * The process-local port/callable object, creation time, and row digest are excluded. Reacquiring a
 * new protected port under a later coordinator epoch therefore creates another conversation lease
 * for this same immutable intent and binding rather than another binding.
 */
export async function nativeRegistrationIntentDigest(
  record: Pick<
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
): Promise<A1Digest> {
  const canonicalIntentSchemaId = parseLiteral(
    record.canonicalIntentSchemaId,
    "remote-claw/native-registration-intent/v1",
    "nativeRegistrationIntent.canonicalIntentSchemaId",
  );
  const registrationAttemptId = parseA1CanonicalId(
    "registrationAttempt",
    record.registrationAttemptId,
    "nativeRegistrationIntent.registrationAttemptId",
  );
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    record.collaborationServerId,
    "nativeRegistrationIntent.collaborationServerId",
  );
  const nativeBindingId = parseA1CanonicalId(
    "nativeBinding",
    record.nativeBindingId,
    "nativeRegistrationIntent.nativeBindingId",
  );
  const descriptorRef = parseA1SafeId(
    record.descriptorRef,
    "nativeRegistrationIntent.descriptorRef",
  );
  const descriptorDigest = parseA1Digest(
    record.descriptorDigest,
    "nativeRegistrationIntent.descriptorDigest",
  );
  const projectRef = parseA1SafeId(record.projectRef, "nativeRegistrationIntent.projectRef");
  const projectDigest = parseA1Digest(
    record.projectDigest,
    "nativeRegistrationIntent.projectDigest",
  );
  const expectedNativeRefDigestValue = record.expectedNativeRefDigest;
  const expectedNativeRefDigest =
    expectedNativeRefDigestValue === null
      ? null
      : parseA1Digest(
          expectedNativeRefDigestValue,
          "nativeRegistrationIntent.expectedNativeRefDigest",
        );
  const initialPhase = parseEnum(
    record.initialPhase,
    ["starting", "recovering"] as const,
    "nativeRegistrationIntent.initialPhase",
  );
  const metadataSchemaId = parseNonEmptyString(
    record.metadataSchemaId,
    "nativeRegistrationIntent.metadataSchemaId",
  );
  const metadataRef = parseA1SafeId(record.metadataRef, "nativeRegistrationIntent.metadataRef");
  const metadataDigest = parseA1Digest(
    record.metadataDigest,
    "nativeRegistrationIntent.metadataDigest",
  );
  const capabilitiesRefValue = record.capabilitiesRef;
  const capabilitiesRef =
    capabilitiesRefValue === null
      ? null
      : parseA1SafeId(capabilitiesRefValue, "nativeRegistrationIntent.capabilitiesRef");
  const capabilitiesDigestValue = record.capabilitiesDigest;
  const capabilitiesDigest =
    capabilitiesDigestValue === null
      ? null
      : parseA1Digest(capabilitiesDigestValue, "nativeRegistrationIntent.capabilitiesDigest");
  if ((capabilitiesRef === null) !== (capabilitiesDigest === null)) {
    throw new HostStateContractError(
      "nativeRegistrationIntent.capabilities reference and digest must either both be null or both be present",
    );
  }
  const writer = new CanonicalWriter();
  writer.str(canonicalIntentSchemaId);
  writer.str(registrationAttemptId);
  writer.str(collaborationServerId);
  writer.str(nativeBindingId);
  writer.str(descriptorRef);
  writer.bytes(digestBytes(descriptorDigest, "nativeRegistrationIntent.descriptorDigest"));
  writer.str(projectRef);
  writer.bytes(digestBytes(projectDigest, "nativeRegistrationIntent.projectDigest"));
  writer.optionalBytes(
    expectedNativeRefDigest === null
      ? null
      : digestBytes(expectedNativeRefDigest, "nativeRegistrationIntent.expectedNativeRefDigest"),
  );
  writer.str(initialPhase);
  writer.str(metadataSchemaId);
  writer.str(metadataRef);
  writer.bytes(digestBytes(metadataDigest, "nativeRegistrationIntent.metadataDigest"));
  writer.optionalStr(capabilitiesRef);
  writer.optionalBytes(
    capabilitiesDigest === null
      ? null
      : digestBytes(capabilitiesDigest, "nativeRegistrationIntent.capabilitiesDigest"),
  );
  return digest(writer);
}

export async function verifyNativeRegistrationIntentDigest(
  record: NativeRegistrationIntentRecord,
): Promise<void> {
  const parsed = parseNativeRegistrationIntentRecord(record);
  const computed = await nativeRegistrationIntentDigest(parsed);
  if (!equalDigest(computed, parsed.canonicalIntentDigest)) {
    throw new HostStateContractError(
      "nativeRegistrationIntent.canonicalIntentDigest does not match its row",
    );
  }
}

/** Exact digest of one closed project-target union arm. */
export async function projectTargetDigest(value: ProjectTarget): Promise<A1Digest> {
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
  return digest(writer);
}

/** Exact deterministic ID for a selected project/selector target generation. */
export async function projectTargetSelectorMappingId(
  record: Pick<
    ProjectTargetSelectorMappingRecord,
    | "collaborationServerId"
    | "projectId"
    | "workspaceSelectorId"
    | "mappingGeneration"
    | "targetDigest"
  >,
): Promise<ProjectTargetSelectorMappingId> {
  const mappingGeneration = record.mappingGeneration;
  if (!Number.isSafeInteger(mappingGeneration) || mappingGeneration <= 0) {
    throw new HostStateContractError(
      "projectTargetSelectorMapping.mappingGeneration must be a positive safe integer",
    );
  }
  const collaborationServerId = parseA1CanonicalId(
    "collaborationServer",
    record.collaborationServerId,
    "projectTargetSelectorMapping.collaborationServerId",
  );
  const projectId = parseA1CanonicalId(
    "project",
    record.projectId,
    "projectTargetSelectorMapping.projectId",
  );
  const workspaceSelectorId = parseA1SafeId(
    record.workspaceSelectorId,
    "projectTargetSelectorMapping.workspaceSelectorId",
  );
  const targetDigest = parseA1Digest(
    record.targetDigest,
    "projectTargetSelectorMapping.targetDigest",
  );
  const writer = new CanonicalWriter();
  writer.str("remote-claw/project-target-selector/v1");
  writer.str(collaborationServerId);
  writer.str(projectId);
  writer.str(workspaceSelectorId);
  writer.uint(mappingGeneration);
  writer.bytes(digestBytes(targetDigest, "projectTargetSelectorMapping.targetDigest"));
  return parseA1CanonicalId(
    "projectTargetSelectorMapping",
    `ptm_${base64urlEncode(await sha256(writer.finish()))}`,
  );
}

export async function verifyProjectTargetSelectorMapping(
  record: ProjectTargetSelectorMappingRecord,
): Promise<void> {
  const parsed = parseProjectTargetSelectorMappingRecord(record);
  const computedTargetDigest = await projectTargetDigest(parsed.target);
  if (!equalDigest(computedTargetDigest, parsed.targetDigest)) {
    throw new HostStateContractError(
      "projectTargetSelectorMapping.targetDigest does not match its target",
    );
  }
  const computedId = await projectTargetSelectorMappingId(parsed);
  if (computedId !== parsed.projectTargetSelectorMappingId) {
    throw new HostStateContractError(
      "projectTargetSelectorMapping.projectTargetSelectorMappingId does not match its row",
    );
  }
}
