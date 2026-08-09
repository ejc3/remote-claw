import { base64urlDecode, base64urlEncode, CanonicalWriter, sha256 } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  HostStateContractError,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
} from "../state/ids.js";
import { ProtectedByteSnapshot } from "../state/protected.js";
import {
  createDurableProjectSelectionEvidence,
  createNativeConversationCapabilitiesEvidence,
  createNativeConversationRefEvidence,
  createNativeEngineDescriptorEvidence,
  createNativeRegistrationMetadataEvidence,
  DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
  digestCanonicalNativeEvidence,
  NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
  NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
  NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
  NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
  parseCanonicalDurableProjectSelectionEvidence,
  parseCanonicalNativeConversationCapabilitiesEvidence,
  parseCanonicalNativeConversationRefEvidence,
  parseCanonicalNativeEngineDescriptorEvidence,
  parseCanonicalNativeRegistrationMetadataEvidence,
  parseDurableProjectSelectionEvidenceValue,
  parseNativeConversationCapabilitiesEvidenceValue,
  parseNativeConversationRefEvidenceValue,
  parseNativeEngineDescriptorEvidenceValue,
  parseNativeRegistrationMetadataEvidenceValue,
  verifyDurableProjectSelectionEvidence,
  verifyNativeConversationCapabilitiesEvidence,
  verifyNativeConversationRefEvidence,
  verifyNativeEngineDescriptorEvidence,
  verifyNativeRegistrationMetadataEvidence,
} from "./evidence.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const collaborationServerId = parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`);
const projectId = parseA1CanonicalId("project", `rcpj_${encoded(16, 2)}`);
const nativeRuntimeId = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 3)}`);
const mappingId = parseA1CanonicalId("projectTargetSelectorMapping", `ptm_${encoded(32, 4)}`);
const targetDigest = parseA1Digest(encoded(32, 5));
const workspaceSelectorId = parseA1SafeId("workspace:alpha");
const conversationId = parseA1SafeId("thread:semantic-1");
const metadataSchemaId = "remote-claw/test-native-metadata/v1";

const descriptorValue = {
  product: "codex",
  access: "app-server",
} as const;

const firstBootstrapValue = {
  kind: "first_bootstrap",
  collaborationServerId,
  workspaceSelectorId,
  terminalDescriptor: {
    product: "claude-code",
    access: "tmux",
  },
  targetDigest,
} as const;

const existingMappingValue = {
  kind: "existing_mapping",
  collaborationServerId,
  projectId,
  workspaceSelectorId,
  projectTargetSelectorMappingId: mappingId,
  mappingGeneration: 7,
  targetDigest,
} as const;

const nativeRefValue = {
  descriptor: {
    product: "opencode",
    access: "server",
  },
  runtimeId: nativeRuntimeId,
  incarnation: 3,
  conversationId,
} as const;

const capabilitiesValue = {
  version: 1,
  mutationAdmission: "mixed",
  history: "complete",
  deliveryEvidence: "native_observation",
  liveReattach: true,
} as const;

const LOCKED_VECTORS = Object.freeze({
  descriptor: Object.freeze({
    bytes:
      "AAAAJ3JlbW90ZS1jbGF3L25hdGl2ZS1lbmdpbmUtZGVzY3JpcHRvci92MQAAAAVjb2RleAAAAAphcHAtc2VydmVy",
    digest: "pI_9NHI6Sbg5BAwTs907TBRj7PA_FQvQxIx4gmHg2AY",
  }),
  firstBootstrap: Object.freeze({
    bytes:
      "AAAAKHJlbW90ZS1jbGF3L2R1cmFibGUtcHJvamVjdC1zZWxlY3Rpb24vdjEAAAAPZmlyc3RfYm9vdHN0cmFwAAAAGnJjc19BUUVCQVFFQkFRRUJBUUVCQVFFQkFRAAAAD3dvcmtzcGFjZTphbHBoYQAAAEIAAAAncmVtb3RlLWNsYXcvbmF0aXZlLWVuZ2luZS1kZXNjcmlwdG9yL3YxAAAAC2NsYXVkZS1jb2RlAAAABHRtdXgAAAAgBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
    digest: "n4iQfnaybUbkWpTiQTtD01Gjwa5kTQeDhGRy5FFbSkI",
  }),
  existingMapping: Object.freeze({
    bytes:
      "AAAAKHJlbW90ZS1jbGF3L2R1cmFibGUtcHJvamVjdC1zZWxlY3Rpb24vdjEAAAAQZXhpc3RpbmdfbWFwcGluZwAAABpyY3NfQVFFQkFRRUJBUUVCQVFFQkFRRUJBUQAAABtyY3BqX0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWcAAAAPd29ya3NwYWNlOmFscGhhAAAAL3B0bV9CQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRAAAACAAAAAAAAAAHAAAAIAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF",
    digest: "hcKD4XF3q1038RHoFh0beq4DixbPB9qxakDWXQopReI",
  }),
  nativeRef: Object.freeze({
    bytes:
      "AAAAJnJlbW90ZS1jbGF3L25hdGl2ZS1jb252ZXJzYXRpb24tcmVmL3YxAAAAQQAAACdyZW1vdGUtY2xhdy9uYXRpdmUtZW5naW5lLWRlc2NyaXB0b3IvdjEAAAAIb3BlbmNvZGUAAAAGc2VydmVyAAAAMHJjcnRfQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TQAAAAgAAAAAAAAAAwAAABF0aHJlYWQ6c2VtYW50aWMtMQ",
    digest: "-EeWWovamvZ4usDi1T0NeHqlRIlGCAkzahoO5mCLIYs",
  }),
  capabilities: Object.freeze({
    bytes:
      "AAAAL3JlbW90ZS1jbGF3L25hdGl2ZS1jb252ZXJzYXRpb24tY2FwYWJpbGl0aWVzL3YxAAAACAAAAAAAAAABAAAABW1peGVkAAAACGNvbXBsZXRlAAAAEm5hdGl2ZV9vYnNlcnZhdGlvbgAAAAgAAAAAAAAAAQ",
    digest: "JMlUAY27XhgWLVxFTYUeE6qRu5Zm8W4o9tu8eUD2dgw",
  }),
  metadata: Object.freeze({
    bytes:
      "AAAANHJlbW90ZS1jbGF3L25hdGl2ZS1yZWdpc3RyYXRpb24tbWV0YWRhdGEtZXZpZGVuY2UvdjEAAAAjcmVtb3RlLWNsYXcvdGVzdC1uYXRpdmUtbWV0YWRhdGEvdjEAAAAFAP8BAgM",
    digest: "-g7EMmcFthqlaNpnRRZuHjuRAmw4ImLolHxsn7mQuhI",
  }),
});

describe("canonical native registration evidence", () => {
  it("freezes the selected schema identifiers", () => {
    expect([
      NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID,
      DURABLE_PROJECT_SELECTION_EVIDENCE_SCHEMA_ID,
      NATIVE_CONVERSATION_REF_EVIDENCE_SCHEMA_ID,
      NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID,
      NATIVE_REGISTRATION_METADATA_EVIDENCE_SCHEMA_ID,
    ]).toEqual([
      "remote-claw/native-engine-descriptor/v1",
      "remote-claw/durable-project-selection/v1",
      "remote-claw/native-conversation-ref/v1",
      "remote-claw/native-conversation-capabilities/v1",
      "remote-claw/native-registration-metadata-evidence/v1",
    ]);
  });

  it("locks exact bytes and SHA-256 digests for every evidence kind", () => {
    const metadataBytes = Uint8Array.of(0, 255, 1, 2, 3);
    const cases = [
      [createNativeEngineDescriptorEvidence(descriptorValue), LOCKED_VECTORS.descriptor],
      [createDurableProjectSelectionEvidence(firstBootstrapValue), LOCKED_VECTORS.firstBootstrap],
      [createDurableProjectSelectionEvidence(existingMappingValue), LOCKED_VECTORS.existingMapping],
      [createNativeConversationRefEvidence(nativeRefValue), LOCKED_VECTORS.nativeRef],
      [
        createNativeConversationCapabilitiesEvidence(capabilitiesValue),
        LOCKED_VECTORS.capabilities,
      ],
      [
        createNativeRegistrationMetadataEvidence({ metadataSchemaId, metadataBytes }),
        LOCKED_VECTORS.metadata,
      ],
    ] as const;

    for (const [evidence, vector] of cases) {
      expect(evidence.canonicalBytes).toBeInstanceOf(ProtectedByteSnapshot);
      expect(base64urlEncode(evidence.canonicalBytes.copyBytes())).toBe(vector.bytes);
      expect(evidence.canonicalDigest).toBe(vector.digest);
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.value)).toBe(true);
    }
  });

  it("round-trips both closed project-selection arms synchronously", () => {
    const first = createDurableProjectSelectionEvidence(firstBootstrapValue);
    const existing = createDurableProjectSelectionEvidence(existingMappingValue);

    expect(parseCanonicalDurableProjectSelectionEvidence(first.canonicalBytes.copyBytes())).toEqual(
      firstBootstrapValue,
    );
    expect(
      verifyDurableProjectSelectionEvidence(first.canonicalBytes.copyBytes(), first.canonicalDigest)
        .value,
    ).toEqual(firstBootstrapValue);
    expect(
      parseCanonicalDurableProjectSelectionEvidence(existing.canonicalBytes.copyBytes()),
    ).toEqual(existingMappingValue);
    expect(
      verifyDurableProjectSelectionEvidence(
        existing.canonicalBytes.copyBytes(),
        existing.canonicalDigest,
      ).value,
    ).toEqual(existingMappingValue);
  });

  it("round-trips descriptor, native ref, capabilities, and schema-bound metadata", () => {
    const descriptor = createNativeEngineDescriptorEvidence(descriptorValue);
    const nativeRef = createNativeConversationRefEvidence(nativeRefValue);
    const capabilities = createNativeConversationCapabilitiesEvidence(capabilitiesValue);
    const metadata = createNativeRegistrationMetadataEvidence({
      metadataSchemaId,
      metadataBytes: Uint8Array.of(0, 255, 1, 2, 3),
    });

    expect(
      parseCanonicalNativeEngineDescriptorEvidence(descriptor.canonicalBytes.copyBytes()),
    ).toEqual(descriptorValue);
    expect(
      verifyNativeEngineDescriptorEvidence(
        descriptor.canonicalBytes.copyBytes(),
        descriptor.canonicalDigest,
      ).value,
    ).toEqual(descriptorValue);
    expect(
      parseCanonicalNativeConversationRefEvidence(nativeRef.canonicalBytes.copyBytes()),
    ).toEqual(nativeRefValue);
    expect(
      verifyNativeConversationRefEvidence(
        nativeRef.canonicalBytes.copyBytes(),
        nativeRef.canonicalDigest,
      ).value,
    ).toEqual(nativeRefValue);
    expect(
      parseCanonicalNativeConversationCapabilitiesEvidence(capabilities.canonicalBytes.copyBytes()),
    ).toEqual(capabilitiesValue);
    expect(
      verifyNativeConversationCapabilitiesEvidence(
        capabilities.canonicalBytes.copyBytes(),
        capabilities.canonicalDigest,
      ).value,
    ).toEqual(capabilitiesValue);
    expect(
      parseCanonicalNativeRegistrationMetadataEvidence(
        metadata.canonicalBytes.copyBytes(),
        metadataSchemaId,
      ).metadataBytes.copyBytes(),
    ).toEqual(Uint8Array.of(0, 255, 1, 2, 3));
    expect(
      verifyNativeRegistrationMetadataEvidence(
        metadata.canonicalBytes.copyBytes(),
        metadata.canonicalDigest,
        metadataSchemaId,
      ).value.metadataBytes.copyBytes(),
    ).toEqual(Uint8Array.of(0, 255, 1, 2, 3));
  });

  it("snapshots opaque source bytes and never exposes retained canonical bytes", () => {
    const source = Uint8Array.of(0, 255, 1, 2, 3);
    const evidence = createNativeRegistrationMetadataEvidence({
      metadataSchemaId,
      metadataBytes: source,
    });
    source.fill(9);

    expect(evidence.value.metadataBytes.copyBytes()).toEqual(Uint8Array.of(0, 255, 1, 2, 3));
    const exposedCanonicalCopy = evidence.canonicalBytes.copyBytes();
    exposedCanonicalCopy.fill(8);
    expect(base64urlEncode(evidence.canonicalBytes.copyBytes())).toBe(
      LOCKED_VECTORS.metadata.bytes,
    );

    const exposedMetadataCopy = evidence.value.metadataBytes.copyBytes();
    exposedMetadataCopy.fill(7);
    expect(evidence.value.metadataBytes.copyBytes()).toEqual(Uint8Array.of(0, 255, 1, 2, 3));
  });

  it("uses the synchronous Node digest selected by the cross-runtime SHA-256 primitive", async () => {
    const bytes = base64urlDecode(LOCKED_VECTORS.nativeRef.bytes);
    expect(digestCanonicalNativeEvidence(bytes)).toBe(base64urlEncode(await sha256(bytes)));
    expect(digestCanonicalNativeEvidence(bytes)).toBe(LOCKED_VECTORS.nativeRef.digest);
  });
});

describe("strict native evidence value parsers", () => {
  it("rejects extra, inherited, accessor, and unsupported descriptor values", () => {
    expect(() =>
      parseNativeEngineDescriptorEvidenceValue({ ...descriptorValue, extra: true }),
    ).toThrow(/exactly the selected fields/);
    expect(() => parseNativeEngineDescriptorEvidenceValue(Object.create(descriptorValue))).toThrow(
      /plain object/,
    );
    expect(() =>
      parseNativeEngineDescriptorEvidenceValue({
        get product() {
          return "codex";
        },
        access: "app-server",
      }),
    ).toThrow(/own data properties/);
    expect(() =>
      parseNativeEngineDescriptorEvidenceValue({ product: "codex", access: "tmux" }),
    ).toThrow(/unsupported product\/access combination/);
  });

  it("requires exactly one complete durable project-selection arm", () => {
    expect(() =>
      parseDurableProjectSelectionEvidenceValue({ ...firstBootstrapValue, projectId }),
    ).toThrow(/exactly the selected fields/);
    const { projectTargetSelectorMappingId: _mapping, ...incompleteExisting } =
      existingMappingValue;
    expect(() => parseDurableProjectSelectionEvidenceValue(incompleteExisting)).toThrow(
      /exactly the selected fields/,
    );
    expect(() =>
      parseDurableProjectSelectionEvidenceValue({
        ...existingMappingValue,
        mappingGeneration: 0,
      }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseDurableProjectSelectionEvidenceValue({ ...firstBootstrapValue, kind: "discover" }),
    ).toThrow(/not a selected value/);
  });

  it("requires canonical native identity and coarse capability enums", () => {
    expect(() =>
      parseNativeConversationRefEvidenceValue({ ...nativeRefValue, incarnation: 0 }),
    ).toThrow(/greater than zero/);
    expect(() =>
      parseNativeConversationRefEvidenceValue({ ...nativeRefValue, runtimeId: conversationId }),
    ).toThrow(/rcrt_/);
    expect(() =>
      parseNativeConversationRefEvidenceValue({ ...nativeRefValue, transportSessionId: "x" }),
    ).toThrow(/exactly the selected fields/);
    expect(() =>
      parseNativeConversationCapabilitiesEvidenceValue({
        ...capabilitiesValue,
        mutationAdmission: "prompt",
      }),
    ).toThrow(/not a selected value/);
    expect(() =>
      parseNativeConversationCapabilitiesEvidenceValue({ ...capabilitiesValue, version: 2 }),
    ).toThrow(/must equal 1/);
    expect(() =>
      parseNativeConversationCapabilitiesEvidenceValue({ ...capabilitiesValue, liveReattach: 1 }),
    ).toThrow(/must be a boolean/);
  });

  it("accepts only opaque Uint8Array metadata bound to a non-empty supplied schema", () => {
    expect(() =>
      parseNativeRegistrationMetadataEvidenceValue({
        metadataSchemaId,
        metadataBytes: [1, 2, 3],
      }),
    ).toThrow(/genuine Uint8Array/);
    expect(() =>
      parseNativeRegistrationMetadataEvidenceValue({
        metadataSchemaId: "",
        metadataBytes: Uint8Array.of(1),
      }),
    ).toThrow(/non-empty string/);
    expect(() =>
      parseNativeRegistrationMetadataEvidenceValue({
        metadataSchemaId,
        metadataBytes: Uint8Array.of(1),
        decoded: {},
      }),
    ).toThrow(/exactly the selected fields/);
  });
});

describe("strict canonical native evidence decoding", () => {
  it("rejects a wrong schema even when the supplied digest matches those bytes", () => {
    const writer = new CanonicalWriter();
    writer.str("remote-claw/native-engine-descriptor/v2");
    writer.str("codex");
    writer.str("app-server");
    const bytes = writer.finish();

    expect(() =>
      verifyNativeEngineDescriptorEvidence(bytes, digestCanonicalNativeEvidence(bytes)),
    ).toThrow(/must equal "remote-claw\/native-engine-descriptor\/v1"/);
  });

  it("rejects truncated, extra, and trailing bytes even with their matching digests", () => {
    const evidence = createNativeEngineDescriptorEvidence(descriptorValue);
    const canonical = evidence.canonicalBytes.copyBytes();
    const truncated = canonical.slice(0, -1);
    const trailing = Uint8Array.from([...canonical, 0]);

    expect(() =>
      verifyNativeEngineDescriptorEvidence(truncated, digestCanonicalNativeEvidence(truncated)),
    ).toThrow(/truncated canonical byte field/);
    expect(() =>
      verifyNativeEngineDescriptorEvidence(trailing, digestCanonicalNativeEvidence(trailing)),
    ).toThrow(/trailing canonical data/);

    const extraField = new CanonicalWriter();
    extraField.str(NATIVE_ENGINE_DESCRIPTOR_EVIDENCE_SCHEMA_ID);
    extraField.str("codex");
    extraField.str("app-server");
    extraField.str("extra");
    const bytes = extraField.finish();
    expect(() =>
      verifyNativeEngineDescriptorEvidence(bytes, digestCanonicalNativeEvidence(bytes)),
    ).toThrow(/trailing canonical data/);
  });

  it("rejects non-selected integer and boolean encodings", () => {
    const shortVersion = new CanonicalWriter();
    shortVersion.str(NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID);
    shortVersion.bytes(Uint8Array.of(1));
    shortVersion.str("mixed");
    shortVersion.str("complete");
    shortVersion.str("native_observation");
    shortVersion.uint(1);
    const shortVersionBytes = shortVersion.finish();
    expect(() =>
      verifyNativeConversationCapabilitiesEvidence(
        shortVersionBytes,
        digestCanonicalNativeEvidence(shortVersionBytes),
      ),
    ).toThrow(/exactly 8 canonical bytes/);

    const invalidBoolean = new CanonicalWriter();
    invalidBoolean.str(NATIVE_CONVERSATION_CAPABILITIES_EVIDENCE_SCHEMA_ID);
    invalidBoolean.uint(1);
    invalidBoolean.str("mixed");
    invalidBoolean.str("complete");
    invalidBoolean.str("native_observation");
    invalidBoolean.uint(2);
    const invalidBooleanBytes = invalidBoolean.finish();
    expect(() =>
      verifyNativeConversationCapabilitiesEvidence(
        invalidBooleanBytes,
        digestCanonicalNativeEvidence(invalidBooleanBytes),
      ),
    ).toThrow(/canonically encoded as zero or one/);
  });

  it("rejects mismatched, malformed, and noncanonical base64url digests", () => {
    const evidence = createNativeConversationRefEvidence(nativeRefValue);
    const bytes = evidence.canonicalBytes.copyBytes();

    expect(() => verifyNativeConversationRefEvidence(bytes, targetDigest)).toThrow(
      /does not match the canonical evidence bytes/,
    );
    expect(() =>
      verifyNativeConversationRefEvidence(bytes, `${evidence.canonicalDigest}=`),
    ).toThrow(/canonical unpadded base64url/);
    expect(() => verifyNativeConversationRefEvidence(bytes, "not-a-digest")).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("rejects opaque metadata under any schema other than the supplied schema", () => {
    const evidence = createNativeRegistrationMetadataEvidence({
      metadataSchemaId,
      metadataBytes: Uint8Array.of(255, 254, 253),
    });
    const bytes = evidence.canonicalBytes.copyBytes();

    expect(() =>
      parseCanonicalNativeRegistrationMetadataEvidence(bytes, "remote-claw/other/v1"),
    ).toThrow(/must equal "remote-claw\/other\/v1"/);
    expect(() =>
      verifyNativeRegistrationMetadataEvidence(
        bytes,
        evidence.canonicalDigest,
        "remote-claw/other/v1",
      ),
    ).toThrow(/must equal "remote-claw\/other\/v1"/);
    expect(() => parseCanonicalNativeRegistrationMetadataEvidence(bytes, "")).toThrow(
      /non-empty string/,
    );
  });

  it("uses the selected contract error without echoing opaque metadata", () => {
    const secretMarker = "opaque-secret-marker";
    let error: unknown;
    try {
      parseNativeRegistrationMetadataEvidenceValue({
        metadataSchemaId,
        metadataBytes: new TextEncoder().encode(secretMarker),
        extra: true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(HostStateContractError);
    expect(String(error)).not.toContain(secretMarker);
  });
});
