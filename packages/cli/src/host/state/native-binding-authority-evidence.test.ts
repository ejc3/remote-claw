import { createHash } from "node:crypto";
import { base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import { describe, expect, expectTypeOf, it } from "vitest";
import { MAX_PROTECTED_ARTIFACT_BYTES } from "./artifacts.js";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "./ids.js";
import {
  nativeBindingCapabilitySnapshotId,
  nativeCapabilitySnapshotAttestationId,
  nativeListenerRegistrationAttestationId,
  nativeRuntimeIsolationAttestationId,
} from "./native-binding-authority.js";
import {
  decodeNativeBindingCapabilityInputVector,
  decodeNativeIsolationEvidenceInputVector,
  decodeNativeListenerEvidenceInputVector,
  decodeNativeWorkspaceBindingInput,
  encodeNativeBindingCapabilityInputVector,
  encodeNativeIsolationEvidenceInputVector,
  encodeNativeListenerEvidenceInputVector,
  encodeNativeWorkspaceBindingInput,
  NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS,
  NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID,
  NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
  NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID,
  NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
  NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
  NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
  NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID,
  NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
  type NativeBindingAuthorityArtifactRole,
  type NativeEvidenceArtifactCommitmentV1,
  nativeBindingAuthorityArtifactDigest,
  OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID,
  parseNativeBindingCapabilityInputVector,
  parseNativeEvidenceArtifactCommitment,
  parseNativeIsolationEvidenceInputVector,
  parseNativeListenerEvidenceInputVector,
  parseNativeWorkspaceBindingInput,
} from "./native-binding-authority-evidence.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

function digest(fill: number) {
  return parseA1Digest(encoded(32, fill));
}

const WORKSPACE_ROLES = [
  "workspace.canonical_directory",
  "workspace.filesystem_identity",
  "workspace.allowed_root",
  "workspace.mount_namespace",
] as const;

const LISTENER_ROLES = [
  "listener.native_executable",
  "listener.front_door_executable",
  "listener.front_door_build_manifest",
  "listener.generated_surface",
  "listener.build_route_registry",
  "listener.measured_dispatch_table",
] as const;

const ISOLATION_ROLES = [
  "isolation.raw_listener_socket",
  "isolation.raw_listener_peer_vector",
  "isolation.exact_process_socket_policy",
  "isolation.tool_namespace_policy",
  "isolation.provider_facade_allowed_process",
  "isolation.provider_facade_policy",
  "isolation.network_namespace",
  "isolation.mount_namespace",
] as const;

const CAPABILITY_ROLES = [
  "capability.native_surface",
  "capability.listener_route_manifest",
  "capability.operation_classification_vector",
  "capability.family_capability_vector",
  "capability.slash_normalizer_implementation",
  "capability.slash_command_table",
  "capability.request_translator_implementation",
  "capability.request_translator_build_manifest",
  "capability.translation_injectivity_proof",
  "capability.user_text_family_evidence",
] as const;

function commitments<const R extends readonly NativeBindingAuthorityArtifactRole[]>(
  roles: R,
  firstDigest: number,
) {
  return roles.map((role, index) => ({
    role,
    artifactSchemaId: NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS[role].artifactSchemaId,
    artifactDigest: digest(firstDigest + index),
    byteLength: 100 + index,
  }));
}

async function fixture() {
  const runtimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 1)}`);
  const nativeIncarnation = 2;
  const runtimeOwnerKeyGeneration = 3;
  const nativeListenerRegistrationAttestationIdValue =
    await nativeListenerRegistrationAttestationId({
      runtimeId,
      nativeIncarnation,
      runtimeOwnerKeyGeneration,
    });
  const runtimeIsolationAttestationId = await nativeRuntimeIsolationAttestationId({
    runtimeId,
    nativeIncarnation,
    runtimeOwnerKeyGeneration,
  });
  const attachmentLeaseId = parseA1SafeId("attachment-lease-1");
  const capabilityGeneration = 4;
  const capabilitySnapshotId = await nativeBindingCapabilitySnapshotId({
    attachmentLeaseId,
    capabilityGeneration,
  });
  const capabilitySnapshotAttestationId = await nativeCapabilitySnapshotAttestationId({
    capabilitySnapshotId,
  });

  const workspace = {
    schemaVersion: 1,
    schemaId: NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
    nativeWorkspaceBindingId: parseA1CanonicalId("nativeWorkspaceBinding", `nwb_${encoded(16, 2)}`),
    runtimeId,
    nativeIncarnation,
    projectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 3)}`),
    nativeWorkspaceId: parseA1SafeId("opencode-workspace-1"),
    directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
    filesystemIdentitySchemaId: NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
    workspaceGeneration: 1,
    artifacts: commitments(WORKSPACE_ROLES, 10),
  };
  const listener = {
    schemaVersion: 1,
    schemaId: NATIVE_LISTENER_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
    nativeListenerRegistrationAttestationId: nativeListenerRegistrationAttestationIdValue,
    runtimeId,
    nativeIncarnation,
    runtimeOwnerIdentityKeyId: parseA1SafeId("runtime-owner-key-1"),
    runtimeOwnerKeyGeneration,
    descriptor: { product: "opencode", access: "server" },
    engineVersion: "1.2.3",
    surfaceSchemaKind: "openapi",
    routeResolutionSchemaId: NATIVE_LISTENER_ROUTE_RESOLUTION_SCHEMA_ID,
    artifacts: commitments(LISTENER_ROLES, 20),
  };
  const isolation = {
    schemaVersion: 1,
    schemaId: NATIVE_ISOLATION_EVIDENCE_INPUT_VECTOR_SCHEMA_ID,
    runtimeIsolationAttestationId,
    runtimeId,
    nativeIncarnation,
    runtimeOwnerIdentityKeyId: listener.runtimeOwnerIdentityKeyId,
    runtimeOwnerKeyGeneration,
    descriptor: listener.descriptor,
    nativeListenerRegistrationAttestationId: nativeListenerRegistrationAttestationIdValue,
    listenerSignedRecordDigest: digest(30),
    processIdentityPolicySchemaId: NATIVE_EXACT_PROCESS_SOCKET_POLICY_SCHEMA_ID,
    artifacts: commitments(ISOLATION_ROLES, 31),
  };
  const capability = {
    schemaVersion: 1,
    schemaId: NATIVE_BINDING_CAPABILITY_INPUT_VECTOR_SCHEMA_ID,
    capabilitySnapshotId,
    capabilitySnapshotAttestationId,
    collaborationServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 4)}`),
    logicalChatId: parseA1CanonicalId("logicalChat", `rcl_${encoded(16, 5)}`),
    nativeBindingId: parseA1CanonicalId("nativeBinding", `rcnb_${encoded(16, 6)}`),
    nativeBindingIncarnationId: parseA1SafeId("binding-incarnation-1"),
    nativeConversationLeaseId: parseA1CanonicalId(
      "nativeConversationLease",
      `rcncl_${encoded(16, 7)}`,
    ),
    nativeRegistrationPublicationId: parseA1SafeId("publication-1"),
    nativeConversationId: parseA1SafeId("ses_native_1"),
    runtimeId,
    nativeIncarnation,
    runtimeOwnerIdentityKeyId: listener.runtimeOwnerIdentityKeyId,
    runtimeOwnerKeyGeneration,
    projectId: workspace.projectId,
    attachmentId: parseA1SafeId("attachment-1"),
    attachmentLeaseId,
    nativeWorkspaceBindingId: workspace.nativeWorkspaceBindingId,
    canonicalDirectoryPathDigest: digest(40),
    nativeWorkspaceBindingDigest: digest(41),
    capabilityGeneration,
    descriptor: listener.descriptor,
    engineVersion: listener.engineVersion,
    nativeSurfaceSchemaId: "remote-claw/opencode-native-surface/v1",
    nativeListenerRegistrationAttestationId: nativeListenerRegistrationAttestationIdValue,
    listenerSignedRecordDigest: isolation.listenerSignedRecordDigest,
    runtimeIsolationAttestationId,
    isolationSignedRecordDigest: digest(42),
    slashCommandNormalizationSchemaId: OPENCODE_SLASH_COMMAND_NORMALIZATION_SCHEMA_ID,
    verifiedAtMs: 1_000,
    artifacts: commitments(CAPABILITY_ROLES, 43),
  };
  return { workspace, listener, isolation, capability };
}

function appendByte(value: Uint8Array, byte: number): Uint8Array {
  const result = new Uint8Array(value.byteLength + 1);
  result.set(value);
  result[value.byteLength] = byte;
  return result;
}

describe("A1.8a1-E1a native binding evidence parents", () => {
  it("locks the ref-free role/schema registry", () => {
    expectTypeOf(
      NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["workspace.canonical_directory"],
    ).toEqualTypeOf<{
      readonly artifactSchemaId: "remote-claw/posix-canonical-directory-evidence/v1";
      readonly maxByteLength: 16384;
      readonly scopeKind: "runtime";
    }>();
    expectTypeOf<
      NativeEvidenceArtifactCommitmentV1<"workspace.canonical_directory">["artifactSchemaId"]
    >().toEqualTypeOf<"remote-claw/posix-canonical-directory-evidence/v1">();
    expectTypeOf(
      NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["listener.native_executable"],
    ).toEqualTypeOf<{
      readonly artifactSchemaId: "remote-claw/native-executable-chunk-manifest/v1";
      readonly maxByteLength: 65536;
      readonly scopeKind: "runtime";
    }>();
    expectTypeOf(
      NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["listener.front_door_executable"],
    ).toEqualTypeOf<{
      readonly artifactSchemaId: "remote-claw/front-door-executable-chunk-manifest/v1";
      readonly maxByteLength: 65536;
      readonly scopeKind: "runtime";
    }>();
    expect(Object.keys(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS)).toEqual([
      "parent.workspace_input",
      "parent.listener_input",
      "parent.isolation_input",
      "parent.capability_input",
      ...WORKSPACE_ROLES,
      ...LISTENER_ROLES,
      ...ISOLATION_ROLES,
      ...CAPABILITY_ROLES,
    ]);
    expect(
      Object.values(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS).every(
        ({ maxByteLength }) => maxByteLength > 0 && maxByteLength <= MAX_PROTECTED_ARTIFACT_BYTES,
      ),
    ).toBe(true);
    expect(
      Object.values(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS).some((entry) =>
        Object.hasOwn(entry, "artifactRef"),
      ),
    ).toBe(false);
  });

  it("strictly parses and byte-round-trips all four fixed parents", async () => {
    const selected = await fixture();
    const workspaceBytes = encodeNativeWorkspaceBindingInput(selected.workspace);
    const listenerBytes = await encodeNativeListenerEvidenceInputVector(selected.listener);
    const isolationBytes = await encodeNativeIsolationEvidenceInputVector(selected.isolation);
    const capabilityBytes = await encodeNativeBindingCapabilityInputVector(selected.capability);

    expect(
      encodeNativeWorkspaceBindingInput(decodeNativeWorkspaceBindingInput(workspaceBytes)),
    ).toEqual(workspaceBytes);
    expect(
      await encodeNativeListenerEvidenceInputVector(
        await decodeNativeListenerEvidenceInputVector(listenerBytes),
      ),
    ).toEqual(listenerBytes);
    expect(
      await encodeNativeIsolationEvidenceInputVector(
        await decodeNativeIsolationEvidenceInputVector(isolationBytes),
      ),
    ).toEqual(isolationBytes);
    expect(
      await encodeNativeBindingCapabilityInputVector(
        await decodeNativeBindingCapabilityInputVector(capabilityBytes),
      ),
    ).toEqual(capabilityBytes);

    expect(
      await Promise.all(
        [workspaceBytes, listenerBytes, isolationBytes, capabilityBytes].map(async (bytes) => ({
          bytes: base64urlEncode(bytes),
          digest: await nativeBindingAuthorityArtifactDigest(bytes),
        })),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "bytes": "AAAALXJlbW90ZS1jbGF3L25hdGl2ZS13b3Jrc3BhY2UtYmluZGluZy1pbnB1dC92MQAAAAgAAAAAAAAAAQAAABpud2JfQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZwAAADByY3J0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUAAAAIAAAAAAAAAAIAAAAbcmNwal9Bd01EQXdNREF3TURBd01EQXdNREF3AQAAABRvcGVuY29kZS13b3Jrc3BhY2UtMQAAADVyZW1vdGUtY2xhdy9wb3NpeC1hYnNvbHV0ZS1kaXJlY3Rvcnktbm9ybWFsaXphdGlvbi92MQAAADJyZW1vdGUtY2xhdy9saW51eC1uby1mb2xsb3ctZmlsZXN5c3RlbS1pZGVudGl0eS92MQAAAAgAAAAAAAAAAQAAAAgAAAAAAAAABAAAAB13b3Jrc3BhY2UuY2Fub25pY2FsX2RpcmVjdG9yeQAAADFyZW1vdGUtY2xhdy9wb3NpeC1jYW5vbmljYWwtZGlyZWN0b3J5LWV2aWRlbmNlL3YxAAAAIAoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKAAAACAAAAAAAAABkAAAAHXdvcmtzcGFjZS5maWxlc3lzdGVtX2lkZW50aXR5AAAAMnJlbW90ZS1jbGF3L2xpbnV4LW5vLWZvbGxvdy1maWxlc3lzdGVtLWlkZW50aXR5L3YxAAAAIAsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLAAAACAAAAAAAAABlAAAAFndvcmtzcGFjZS5hbGxvd2VkX3Jvb3QAAAAqcmVtb3RlLWNsYXcvbGludXgtYWxsb3dlZC1yb290LWFuY2VzdHJ5L3YxAAAAIAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMAAAACAAAAAAAAABmAAAAGXdvcmtzcGFjZS5tb3VudF9uYW1lc3BhY2UAAAAtcmVtb3RlLWNsYXcvbGludXgtbW91bnQtbmFtZXNwYWNlLWlkZW50aXR5L3YxAAAAIA0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NAAAACAAAAAAAAABn",
          "digest": "US3PYEVdzfGJ_nFaM-O1PFpqB2QahtmEe682Q-F9u80",
        },
        {
          "bytes": "AAAANHJlbW90ZS1jbGF3L25hdGl2ZS1saXN0ZW5lci1ldmlkZW5jZS1pbnB1dC12ZWN0b3IvdjEAAAAIAAAAAAAAAAEAAAAwbmxyYV9vRHJZMkY1OTF0d0IyLUhRUjZ1THpObjhhdHNyZk92LU5MYmVSa202VXhZAAAAMHJjcnRfQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRQAAAAgAAAAAAAAAAgAAABNydW50aW1lLW93bmVyLWtleS0xAAAACAAAAAAAAAADAAAACG9wZW5jb2RlAAAABnNlcnZlcgAAAAUxLjIuMwAAAAdvcGVuYXBpAAAAL3JlbW90ZS1jbGF3L25hdGl2ZS1saXN0ZW5lci1yb3V0ZS1yZXNvbHV0aW9uL3YxAAAACAAAAAAAAAAGAAAAGmxpc3RlbmVyLm5hdGl2ZV9leGVjdXRhYmxlAAAAL3JlbW90ZS1jbGF3L25hdGl2ZS1leGVjdXRhYmxlLWNodW5rLW1hbmlmZXN0L3YxAAAAIBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUAAAACAAAAAAAAABkAAAAHmxpc3RlbmVyLmZyb250X2Rvb3JfZXhlY3V0YWJsZQAAADNyZW1vdGUtY2xhdy9mcm9udC1kb29yLWV4ZWN1dGFibGUtY2h1bmstbWFuaWZlc3QvdjEAAAAgFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUAAAAIAAAAAAAAAGUAAAAibGlzdGVuZXIuZnJvbnRfZG9vcl9idWlsZF9tYW5pZmVzdAAAADByZW1vdGUtY2xhdy9mcm9udC1kb29yLWJ1aWxkLWNsb3N1cmUtbWFuaWZlc3QvdjEAAAAgFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYAAAAIAAAAAAAAAGYAAAAabGlzdGVuZXIuZ2VuZXJhdGVkX3N1cmZhY2UAAAAvcmVtb3RlLWNsYXcvbmF0aXZlLWdlbmVyYXRlZC1vcGVuYXBpLXN1cmZhY2UvdjEAAAAgFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcAAAAIAAAAAAAAAGcAAAAdbGlzdGVuZXIuYnVpbGRfcm91dGVfcmVnaXN0cnkAAAAzcmVtb3RlLWNsYXcvbmF0aXZlLWxpc3RlbmVyLWJ1aWxkLXJvdXRlLXJlZ2lzdHJ5L3YxAAAAIBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYAAAACAAAAAAAAABoAAAAIGxpc3RlbmVyLm1lYXN1cmVkX2Rpc3BhdGNoX3RhYmxlAAAANnJlbW90ZS1jbGF3L25hdGl2ZS1saXN0ZW5lci1tZWFzdXJlZC1kaXNwYXRjaC10YWJsZS92MQAAACAZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGQAAAAgAAAAAAAAAaQ",
          "digest": "2jzPlt-_6HrWnsID0mqZWApH_3VKDVKxzZQoF0jLAuQ",
        },
        {
          "bytes": "AAAANXJlbW90ZS1jbGF3L25hdGl2ZS1pc29sYXRpb24tZXZpZGVuY2UtaW5wdXQtdmVjdG9yL3YxAAAACAAAAAAAAAABAAAAMG5yaWFfekZIYmpteTVaSlpDYmZybEhlcWZjSTI1XzJjbkFQZkZFTGV1V0V1RXBBZwAAADByY3J0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUAAAAIAAAAAAAAAAIAAAATcnVudGltZS1vd25lci1rZXktMQAAAAgAAAAAAAAAAwAAAAhvcGVuY29kZQAAAAZzZXJ2ZXIAAAAwbmxyYV9vRHJZMkY1OTF0d0IyLUhRUjZ1THpObjhhdHNyZk92LU5MYmVSa202VXhZAAAAIB4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eAAAAKnJlbW90ZS1jbGF3L2V4YWN0LXByb2Nlc3Mtc29ja2V0LXBvbGljeS92MQAAAAgAAAAAAAAACAAAAB1pc29sYXRpb24ucmF3X2xpc3RlbmVyX3NvY2tldAAAADFyZW1vdGUtY2xhdy9saW51eC1yYXctbGlzdGVuZXItc29ja2V0LWlkZW50aXR5L3YxAAAAIB8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fAAAACAAAAAAAAABkAAAAImlzb2xhdGlvbi5yYXdfbGlzdGVuZXJfcGVlcl92ZWN0b3IAAAAzcmVtb3RlLWNsYXcvbmF0aXZlLXJ1bnRpbWUtaXNvbGF0aW9uLXBlZXItdmVjdG9yL3YxAAAAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAACAAAAAAAAABlAAAAJWlzb2xhdGlvbi5leGFjdF9wcm9jZXNzX3NvY2tldF9wb2xpY3kAAAA5cmVtb3RlLWNsYXcvbGludXgtZXhhY3QtcHJvY2Vzcy1zb2NrZXQtcG9saWN5LWV2aWRlbmNlL3YxAAAAICEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhAAAACAAAAAAAAABmAAAAH2lzb2xhdGlvbi50b29sX25hbWVzcGFjZV9wb2xpY3kAAAAzcmVtb3RlLWNsYXcvbGludXgtdG9vbC1uYW1lc3BhY2UtcG9saWN5LWV2aWRlbmNlL3YxAAAAICIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiAAAACAAAAAAAAABnAAAAKWlzb2xhdGlvbi5wcm92aWRlcl9mYWNhZGVfYWxsb3dlZF9wcm9jZXNzAAAANXJlbW90ZS1jbGF3L25hdGl2ZS1ydW50aW1lLWlzb2xhdGlvbi1wcm92aWRlci1wZWVyL3YxAAAAICMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjAAAACAAAAAAAAABoAAAAIGlzb2xhdGlvbi5wcm92aWRlcl9mYWNhZGVfcG9saWN5AAAANHJlbW90ZS1jbGF3L2xpbnV4LXByb3ZpZGVyLWZhY2FkZS1wb2xpY3ktZXZpZGVuY2UvdjEAAAAgJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQAAAAIAAAAAAAAAGkAAAAbaXNvbGF0aW9uLm5ldHdvcmtfbmFtZXNwYWNlAAAAL3JlbW90ZS1jbGF3L2xpbnV4LW5ldHdvcmstbmFtZXNwYWNlLWlkZW50aXR5L3YxAAAAICUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlAAAACAAAAAAAAABqAAAAGWlzb2xhdGlvbi5tb3VudF9uYW1lc3BhY2UAAAAtcmVtb3RlLWNsYXcvbGludXgtbW91bnQtbmFtZXNwYWNlLWlkZW50aXR5L3YxAAAAICYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmAAAACAAAAAAAAABr",
          "digest": "J7cr7-5yuEv0uF0CDKonczu8XHfQPCHngUfNrR-qzVY",
        },
        {
          "bytes": "AAAANXJlbW90ZS1jbGF3L25hdGl2ZS1iaW5kaW5nLWNhcGFiaWxpdHktaW5wdXQtdmVjdG9yL3YxAAAACAAAAAAAAAABAAAAMG5iY3NfbjJ2YkJjekRsak44R0ZheEhUeG16NjBoR0k2RlRaMkQxeHBDRUNwcmJ0OAAAADBuY3NhX2RXclJURE55bGlRdm9RbUx1TkZCRnc2Y2hDWW1hR1ZrdEtDbEZGaGFKaEEAAAAacmNzX0JBUUVCQVFFQkFRRUJBUUVCQVFFQkEAAAAacmNsX0JRVUZCUVVGQlFVRkJRVUZCUVVGQlEAAAAbcmNuYl9CZ1lHQmdZR0JnWUdCZ1lHQmdZR0JnAAAAFWJpbmRpbmctaW5jYXJuYXRpb24tMQAAABxyY25jbF9Cd2NIQndjSEJ3Y0hCd2NIQndjSEJ3AAAADXB1YmxpY2F0aW9uLTEAAAAMc2VzX25hdGl2ZV8xAAAAMHJjcnRfQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRQAAAAgAAAAAAAAAAgAAABNydW50aW1lLW93bmVyLWtleS0xAAAACAAAAAAAAAADAAAAG3JjcGpfQXdNREF3TURBd01EQXdNREF3TURBdwAAAAxhdHRhY2htZW50LTEAAAASYXR0YWNobWVudC1sZWFzZS0xAAAAGm53Yl9BZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnAAAAICgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoAAAAICkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpAAAACAAAAAAAAAAEAAAACG9wZW5jb2RlAAAABnNlcnZlcgAAAAUxLjIuMwAAACZyZW1vdGUtY2xhdy9vcGVuY29kZS1uYXRpdmUtc3VyZmFjZS92MQAAADBubHJhX29EclkyRjU5MXR3QjItSFFSNnVMek5uOGF0c3JmT3YtTkxiZVJrbTZVeFkAAAAgHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4AAAAwbnJpYV96Rkhiam15NVpKWkNiZnJsSGVxZmNJMjVfMmNuQVBmRkVMZXVXRXVFcEFnAAAAICoqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqAAAAM3JlbW90ZS1jbGF3L29wZW5jb2RlLXNsYXNoLWNvbW1hbmQtbm9ybWFsaXphdGlvbi92MQAAAAgAAAAAAAAD6AAAAAgAAAAAAAAACgAAABljYXBhYmlsaXR5Lm5hdGl2ZV9zdXJmYWNlAAAALXJlbW90ZS1jbGF3L25hdGl2ZS1zdXJmYWNlLXNjaGVtYS1hcnRpZmFjdC92MQAAACArKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKwAAAAgAAAAAAAAAZAAAACJjYXBhYmlsaXR5Lmxpc3RlbmVyX3JvdXRlX21hbmlmZXN0AAAANnJlbW90ZS1jbGF3L25hdGl2ZS1saXN0ZW5lci1yb3V0ZS1tYW5pZmVzdC1hcnRpZmFjdC92MQAAACAsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLAAAAAgAAAAAAAAAZQAAACpjYXBhYmlsaXR5Lm9wZXJhdGlvbl9jbGFzc2lmaWNhdGlvbl92ZWN0b3IAAAA1cmVtb3RlLWNsYXcvbmF0aXZlLW9wZXJhdGlvbi1jbGFzc2lmaWNhdGlvbi12ZWN0b3IvdjEAAAAgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0AAAAIAAAAAAAAAGYAAAAjY2FwYWJpbGl0eS5mYW1pbHlfY2FwYWJpbGl0eV92ZWN0b3IAAAAscmVtb3RlLWNsYXcvbmF0aXZlLW11dGF0aW9uLWZhbWlseS12ZWN0b3IvdjEAAAAgLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4AAAAIAAAAAAAAAGcAAAAqY2FwYWJpbGl0eS5zbGFzaF9ub3JtYWxpemVyX2ltcGxlbWVudGF0aW9uAAAAN3JlbW90ZS1jbGF3L29wZW5jb2RlLXNsYXNoLW5vcm1hbGl6ZXItaW1wbGVtZW50YXRpb24vdjEAAAAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8AAAAIAAAAAAAAAGgAAAAeY2FwYWJpbGl0eS5zbGFzaF9jb21tYW5kX3RhYmxlAAAAK3JlbW90ZS1jbGF3L29wZW5jb2RlLXNsYXNoLWNvbW1hbmQtdGFibGUvdjEAAAAgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAAAAAIAAAAAAAAAGkAAAAsY2FwYWJpbGl0eS5yZXF1ZXN0X3RyYW5zbGF0b3JfaW1wbGVtZW50YXRpb24AAAA3cmVtb3RlLWNsYXcvbmF0aXZlLXJlcXVlc3QtdHJhbnNsYXRvci1pbXBsZW1lbnRhdGlvbi92MQAAACAxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMQAAAAgAAAAAAAAAagAAACxjYXBhYmlsaXR5LnJlcXVlc3RfdHJhbnNsYXRvcl9idWlsZF9tYW5pZmVzdAAAADdyZW1vdGUtY2xhdy9uYXRpdmUtcmVxdWVzdC10cmFuc2xhdG9yLWJ1aWxkLW1hbmlmZXN0L3YxAAAAIDIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyAAAACAAAAAAAAABrAAAAKGNhcGFiaWxpdHkudHJhbnNsYXRpb25faW5qZWN0aXZpdHlfcHJvb2YAAAA7cmVtb3RlLWNsYXcvbmF0aXZlLXJlcXVlc3QtdHJhbnNsYXRpb24taW5qZWN0aXZpdHktcHJvb2YvdjEAAAAgMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMAAAAIAAAAAAAAAGwAAAAkY2FwYWJpbGl0eS51c2VyX3RleHRfZmFtaWx5X2V2aWRlbmNlAAAAL3JlbW90ZS1jbGF3L25hdGl2ZS11c2VyLXRleHQtZmFtaWx5LWV2aWRlbmNlL3YxAAAAIDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0AAAACAAAAAAAAABt",
          "digest": "j7zTU08qF7JvmRmI7XubXK7nAQgaF69ARDfrOAbSiLw",
        },
      ]
    `);
  });

  it("rejects storage refs, reordered roles, wrong schemas, and oversized children", async () => {
    const selected = await fixture();
    const workspaceCommitment = parseNativeEvidenceArtifactCommitment(
      selected.workspace.artifacts[0],
      "workspace.canonical_directory",
    );
    expectTypeOf(
      workspaceCommitment.artifactSchemaId,
    ).toEqualTypeOf<"remote-claw/posix-canonical-directory-evidence/v1">();
    expect(() =>
      parseNativeEvidenceArtifactCommitment(
        selected.workspace.artifacts[0],
        "capability.native_surface",
      ),
    ).toThrow(/role must equal capability\.native_surface/);

    expect(() =>
      parseNativeEvidenceArtifactCommitment({
        ...selected.workspace.artifacts[0],
        artifactRef: `rcph_${encoded(16, 9)}`,
      }),
    ).toThrow(/must contain exactly the selected fields/);

    expect(() =>
      parseNativeWorkspaceBindingInput({
        ...selected.workspace,
        artifacts: [
          selected.workspace.artifacts[1],
          selected.workspace.artifacts[0],
          ...selected.workspace.artifacts.slice(2),
        ],
      }),
    ).toThrow(/must equal workspace\.canonical_directory/);

    const hostileArtifacts = [...selected.workspace.artifacts];
    Object.defineProperty(hostileArtifacts, "map", { value: () => [] });
    expect(() =>
      parseNativeWorkspaceBindingInput({
        ...selected.workspace,
        artifacts: hostileArtifacts,
      }),
    ).toThrow(/artifacts must contain exactly 4 indexed entries/);

    expect(() =>
      parseNativeWorkspaceBindingInput({
        ...selected.workspace,
        artifacts: selected.workspace.artifacts.map((entry, index) =>
          index === 0 ? { ...entry, artifactSchemaId: "remote-claw/wrong/v1" } : entry,
        ),
      }),
    ).toThrow(/artifactSchemaId must equal/);

    expect(() =>
      parseNativeEvidenceArtifactCommitment({
        ...selected.workspace.artifacts[0],
        byteLength:
          NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["workspace.canonical_directory"].maxByteLength +
          1,
      }),
    ).toThrow(/byteLength must be at most/);
  });

  it("rejects cross-coordinate derived IDs", async () => {
    const selected = await fixture();
    const wrongListenerId = await nativeListenerRegistrationAttestationId({
      runtimeId: selected.listener.runtimeId,
      nativeIncarnation: selected.listener.nativeIncarnation,
      runtimeOwnerKeyGeneration: selected.listener.runtimeOwnerKeyGeneration + 1,
    });
    await expect(
      parseNativeListenerEvidenceInputVector({
        ...selected.listener,
        nativeListenerRegistrationAttestationId: wrongListenerId,
      }),
    ).rejects.toThrow(/must match its runtime\/incarnation\/key-generation derivation/);

    await expect(
      parseNativeIsolationEvidenceInputVector({
        ...selected.isolation,
        nativeListenerRegistrationAttestationId: wrongListenerId,
      }),
    ).rejects.toThrow(/must match the same runtime\/incarnation\/key-generation derivation/);

    const wrongSnapshotId = await nativeBindingCapabilitySnapshotId({
      attachmentLeaseId: selected.capability.attachmentLeaseId,
      capabilityGeneration: selected.capability.capabilityGeneration + 1,
    });
    await expect(
      parseNativeBindingCapabilityInputVector({
        ...selected.capability,
        capabilitySnapshotId: wrongSnapshotId,
      }),
    ).rejects.toThrow(/must match its attachment-lease\/capability-generation derivation/);
  });

  it("rejects truncation, trailing bytes, malformed UTF-8, and invalid optional presence", async () => {
    const selected = await fixture();
    const workspaceBytes = encodeNativeWorkspaceBindingInput(selected.workspace);
    expect(() => decodeNativeWorkspaceBindingInput(workspaceBytes.slice(0, -1))).toThrow(
      /truncated/,
    );
    expect(() => decodeNativeWorkspaceBindingInput(appendByte(workspaceBytes, 0))).toThrow(
      /trailing bytes/,
    );
    expect(() => decodeNativeWorkspaceBindingInput(Uint8Array.of(0, 0, 0, 1, 0xff))).toThrow(
      /canonical UTF-8/,
    );

    const writer = new CanonicalWriter();
    writer.str(NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID);
    writer.uint(1);
    writer.str(selected.workspace.nativeWorkspaceBindingId);
    writer.str(selected.workspace.runtimeId);
    writer.uint(selected.workspace.nativeIncarnation);
    writer.str(selected.workspace.projectId);
    expect(() => decodeNativeWorkspaceBindingInput(appendByte(writer.finish(), 2))).toThrow(
      /presence must equal 0 or 1/,
    );

    await expect(
      decodeNativeBindingCapabilityInputVector(new Uint8Array(64 * 1024 + 1)),
    ).rejects.toThrow(/canonical bytes/);

    await expect(
      encodeNativeListenerEvidenceInputVector({
        ...selected.listener,
        engineVersion: "\ud800",
      }),
    ).rejects.toThrow(/Unicode scalar values/);
    await expect(
      encodeNativeBindingCapabilityInputVector({
        ...selected.capability,
        nativeSurfaceSchemaId: "remote-claw/native\u0000surface/v1",
      }),
    ).rejects.toThrow(/must not contain U\+0000/);
  });

  it("commits every child role, digest, and length into its parent bytes", async () => {
    const selected = await fixture();
    const cases = [
      {
        value: selected.workspace,
        encode: async (value: unknown) => encodeNativeWorkspaceBindingInput(value),
      },
      { value: selected.listener, encode: encodeNativeListenerEvidenceInputVector },
      { value: selected.isolation, encode: encodeNativeIsolationEvidenceInputVector },
      { value: selected.capability, encode: encodeNativeBindingCapabilityInputVector },
    ];

    for (const selectedCase of cases) {
      const original = await selectedCase.encode(selectedCase.value);
      for (let index = 0; index < selectedCase.value.artifacts.length; index++) {
        const changedDigest = {
          ...selectedCase.value,
          artifacts: selectedCase.value.artifacts.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, artifactDigest: digest(90 + index) } : entry,
          ),
        };
        const changedLength = {
          ...selectedCase.value,
          artifacts: selectedCase.value.artifacts.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, byteLength: entry.byteLength + 1 } : entry,
          ),
        };
        expect(await selectedCase.encode(changedDigest)).not.toEqual(original);
        expect(await selectedCase.encode(changedLength)).not.toEqual(original);
      }
    }
  });

  it("snapshots nested input before asynchronous ID derivation", async () => {
    const selected = await fixture();
    const descriptor = { ...selected.listener.descriptor };
    const artifacts = selected.listener.artifacts.map((entry) => ({ ...entry }));
    const expected = await encodeNativeListenerEvidenceInputVector(selected.listener);
    const pending = encodeNativeListenerEvidenceInputVector({
      ...selected.listener,
      descriptor,
      artifacts,
    });

    descriptor.product = "changed";
    const firstArtifact = artifacts[0];
    if (firstArtifact === undefined) throw new Error("fixture artifact is missing");
    firstArtifact.artifactDigest = digest(99);

    await expect(pending).resolves.toEqual(expected);
  });

  it("hashes only bounded, fixed snapshots", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const pending = nativeBindingAuthorityArtifactDigest(source);
    source.fill(9);
    await expect(pending).resolves.toBe(
      parseA1Digest(
        createHash("sha256")
          .update(Uint8Array.of(1, 2, 3))
          .digest("base64url"),
      ),
    );
    await expect(nativeBindingAuthorityArtifactDigest(new Uint8Array())).rejects.toThrow(
      /must contain 1/,
    );
    await expect(
      nativeBindingAuthorityArtifactDigest(new Uint8Array(MAX_PROTECTED_ARTIFACT_BYTES + 1)),
    ).rejects.toThrow(/must contain 1/);
  });
});
