import { base64urlDecode, base64urlEncode, CanonicalWriter, sha256 } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  nativeRuntimeId,
  projectTargetDigest,
  projectTargetSelectorMappingId,
  verifyNativeRuntimeId,
} from "./digests.js";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId, parseWardenLaunchNonce } from "./ids.js";

function encoded(bytes: number, fill: number): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function noncanonicalTailAlias(value: string): string {
  const last = value.at(-1);
  const index = last === undefined ? -1 : BASE64URL_ALPHABET.indexOf(last);
  const replacement = BASE64URL_ALPHABET.at(index + 1);
  if (index < 0 || index % 4 !== 0 || replacement === undefined) {
    throw new Error("expected a canonical 32-byte base64url value");
  }
  return `${value.slice(0, -1)}${replacement}`;
}

describe("A1 digest builder input contracts", () => {
  it("locks the founding native-runtime ID vector and its canonical encoding", async () => {
    const wardenLaunchNonce = parseWardenLaunchNonce(encoded(32, 11));
    const startIdentitySchemaId = "remote-claw/codex-start-identity/v1";
    const startIdentityDigest = parseA1Digest(encoded(32, 12));
    const input = { wardenLaunchNonce, startIdentitySchemaId, startIdentityDigest };

    await expect(nativeRuntimeId(input)).resolves.toBe(
      "rcrt_9eXZ6t2i1B6q6KnTszDoABv6BWYw0blCRXoNgPxF1WM",
    );

    const writer = new CanonicalWriter();
    writer.str("remote-claw/native-runtime-id/v1");
    writer.bytes(base64urlDecode(wardenLaunchNonce));
    writer.str(startIdentitySchemaId);
    writer.bytes(base64urlDecode(startIdentityDigest));
    const independentlyEncoded = `rcrt_${base64urlEncode(await sha256(writer.finish()))}`;
    await expect(nativeRuntimeId(input)).resolves.toBe(independentlyEncoded);
  });

  it("uses each founding runtime-ID component exactly once and rejects malformed bytes", async () => {
    const nonce = encoded(32, 11);
    const digest = encoded(32, 12);
    let nonceReads = 0;
    let schemaReads = 0;
    let digestReads = 0;
    const input = {
      get wardenLaunchNonce() {
        nonceReads++;
        return parseWardenLaunchNonce(nonce);
      },
      get startIdentitySchemaId() {
        schemaReads++;
        return "remote-claw/codex-start-identity/v1";
      },
      get startIdentityDigest() {
        digestReads++;
        return parseA1Digest(digest);
      },
    };

    await expect(nativeRuntimeId(input)).resolves.toMatch(/^rcrt_/);
    expect({ nonceReads, schemaReads, digestReads }).toEqual({
      nonceReads: 1,
      schemaReads: 1,
      digestReads: 1,
    });
    await expect(
      nativeRuntimeId({
        ...input,
        wardenLaunchNonce: noncanonicalTailAlias(nonce) as ReturnType<
          typeof parseWardenLaunchNonce
        >,
      }),
    ).rejects.toThrow(/canonical/);
    await expect(
      nativeRuntimeId({
        ...input,
        startIdentityDigest: encoded(31, 12) as ReturnType<typeof parseA1Digest>,
      }),
    ).rejects.toThrow(/exactly 32 bytes/);
  });

  it("verifies a runtime root against founding evidence without using successor identity", async () => {
    const wardenLaunchNonce = parseWardenLaunchNonce(encoded(32, 11));
    const initialStartIdentityDigest = parseA1Digest(encoded(32, 12));
    const initialStartIdentitySchemaId = "remote-claw/codex-start-identity/v1";
    const runtimeId = await nativeRuntimeId({
      wardenLaunchNonce,
      startIdentitySchemaId: initialStartIdentitySchemaId,
      startIdentityDigest: initialStartIdentityDigest,
    });
    const record = {
      runtimeId,
      descriptor: { product: "codex", access: "app-server" },
      wardenLaunchNonce,
      initialStartIdentitySchemaId,
      initialStartIdentityRef: parseA1SafeId("start-identity-1"),
      initialStartIdentityDigest,
      currentNativeIncarnation: 7,
      currentRuntimeOwnerAssignmentId: parseA1SafeId("runtime-owner-assignment-7"),
      createdAtMs: 10,
      closedAtMs: null,
      state: "current",
    } as const;

    await expect(verifyNativeRuntimeId(record)).resolves.toBeUndefined();
    await expect(
      verifyNativeRuntimeId({
        ...record,
        runtimeId: parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 13)}`),
      }),
    ).rejects.toThrow(/does not match its founding identity/);
  });

  it("rejects an impossible zero mapping generation before deriving an ID", async () => {
    await expect(
      projectTargetSelectorMappingId({
        collaborationServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`),
        projectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 2)}`),
        workspaceSelectorId: parseA1SafeId("workspace-selector-1"),
        mappingGeneration: 0,
        targetDigest: parseA1Digest(encoded(32, 3)),
      }),
    ).rejects.toThrow(/mappingGeneration must be a positive safe integer/);
  });

  it("locks the nested-server project-target encoding", async () => {
    await expect(
      projectTargetDigest({
        kind: "nested_server",
        nestedServerManagementBindingId: parseA1SafeId("nested-management-1"),
        targetServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 4)}`),
        targetProjectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 5)}`),
        targetWorkspaceSelectorId: parseA1SafeId("workspace-selector-2"),
      }),
    ).resolves.toBe("Vfe5sLTppqjI9Z6b6vxSW0ZioTRCKWCnzI4o3yK5oTA");
  });

  it("validates mapping digest bytes before decoding and snapshots generation once", async () => {
    const targetDigest = encoded(32, 3);
    const base = {
      collaborationServerId: parseA1CanonicalId("collaborationServer", `rcs_${encoded(16, 1)}`),
      projectId: parseA1CanonicalId("project", `rcpj_${encoded(16, 2)}`),
      workspaceSelectorId: parseA1SafeId("workspace-selector-1"),
      targetDigest: parseA1Digest(targetDigest),
    };

    for (const malformed of [noncanonicalTailAlias(targetDigest), "A".repeat(1_000_000)]) {
      await expect(
        projectTargetSelectorMappingId({
          ...base,
          mappingGeneration: 1,
          targetDigest: malformed as ReturnType<typeof parseA1Digest>,
        }),
      ).rejects.toThrow(/canonical|exactly 32 bytes/);
    }

    let generationReads = 0;
    const accessorBacked = {
      ...base,
      get mappingGeneration() {
        generationReads++;
        return 1;
      },
    };
    await expect(projectTargetSelectorMappingId(accessorBacked)).resolves.toMatch(/^ptm_/);
    expect(generationReads).toBe(1);
  });
});
