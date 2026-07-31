import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import { projectTargetDigest, projectTargetSelectorMappingId } from "./digests.js";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "./ids.js";

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
