import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, expectTypeOf, it } from "vitest";
import { parseA1Digest } from "./ids.js";
import {
  NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS,
  parseNativeEvidenceArtifactCommitment,
} from "./native-binding-authority-evidence.js";
import {
  type CanonicalExecutableManifestArtifact,
  canonicalExecutableManifestArtifact,
  decodeExecutableChunkManifest,
  EXECUTABLE_DIGEST_ALGORITHM,
  EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE,
  type ExecutableChunkDigestV1,
  type ExecutableManifestRole,
  encodeExecutableChunkManifest,
  executableChunkDigest,
  executableChunkVectorDigest,
  FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID,
  FRONT_DOOR_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID,
  MAX_EXECUTABLE_BYTES,
  MAX_EXECUTABLE_MANIFEST_BYTES,
  NATIVE_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID,
  NOMINAL_EXECUTABLE_CHUNK_BYTES,
  parseExecutableChunkManifest,
} from "./native-binding-authority-executable-evidence.js";

function digest(bytes: Uint8Array) {
  return parseA1Digest(base64urlEncode(createHash("sha256").update(bytes).digest()));
}

async function artifactForBytes<Role extends ExecutableManifestRole>(
  role: Role,
  source: Uint8Array,
): Promise<CanonicalExecutableManifestArtifact<Role>> {
  const bytes = new Uint8Array(source);
  const chunks: ExecutableChunkDigestV1[] = [];
  const count = Math.ceil(bytes.byteLength / NOMINAL_EXECUTABLE_CHUNK_BYTES);
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
    const byteOffset = chunkIndex * NOMINAL_EXECUTABLE_CHUNK_BYTES;
    const byteLength = Math.min(NOMINAL_EXECUTABLE_CHUNK_BYTES, bytes.byteLength - byteOffset);
    chunks.push(
      Object.freeze({
        chunkIndex,
        byteOffset,
        byteLength,
        chunkDigest: await executableChunkDigest({
          role,
          fileByteLength: bytes.byteLength,
          chunkIndex,
          byteOffset,
          chunkBytes: bytes.subarray(byteOffset, byteOffset + byteLength),
        }),
      }),
    );
  }
  const frozenChunks = Object.freeze(chunks);
  return canonicalExecutableManifestArtifact(
    {
      schemaId: EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE[role],
      schemaVersion: 1,
      chunkingSchemaId: FIXED_EXECUTABLE_CHUNKING_SCHEMA_ID,
      digestAlgorithm: EXECUTABLE_DIGEST_ALGORITHM,
      nominalChunkBytes: NOMINAL_EXECUTABLE_CHUNK_BYTES,
      fileByteLength: bytes.byteLength,
      rawFileSha256: digest(bytes),
      chunkCount: frozenChunks.length,
      chunks: frozenChunks,
      chunkVectorDigest: await executableChunkVectorDigest(role, bytes.byteLength, frozenChunks),
    },
    role,
  );
}

function changedDigest(value: string): string {
  return value.startsWith("A") ? `B${value.slice(1)}` : `A${value.slice(1)}`;
}

describe("native binding executable manifest codec", () => {
  it("locks the native and front-door domain-separated byte vectors", async () => {
    const source = Uint8Array.of(0, 1, 2, 3, 254, 255);
    const native = await artifactForBytes("listener.native_executable", source);
    const frontDoor = await artifactForBytes("listener.front_door_executable", source);

    expect(native.manifest).toMatchObject({
      schemaId: NATIVE_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID,
      rawFileSha256: "fqZGlYcV7Wh6qawvXXhf6xqTQR9PJf3Wx_zGqwf98OM",
      chunkVectorDigest: "cvf7BhVgUz6UwFKFL-RFGjkPGfqVtFwNFX6Hksz7IRY",
      chunks: [{ chunkDigest: "QObg6HfQdxYkDLtzLyQ08_sTR9F_LC2H0UgEqHgoT50" }],
    });
    expect(frontDoor.manifest).toMatchObject({
      schemaId: FRONT_DOOR_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID,
      rawFileSha256: native.manifest.rawFileSha256,
      chunkVectorDigest: "Er25H4gLPFy9bT4FQeVABVpOCgzW8ktlSb-CVtFz0rw",
      chunks: [{ chunkDigest: "KqaZwEncwfueuKjrTUY8X7Tk9h49vCTuny4AghWCnn4" }],
    });
    expect(native.commitment.artifactDigest).toBe("hrhncrD4hHpDCOJxwM55k52nnLklz0EHGKvNiSoP_is");
    expect(frontDoor.commitment.artifactDigest).toBe("YBFpvBDMaMKnrqhGo4nV--Cdy9ENOjuV6xmvTUiWXio");
    expect(Buffer.from(native.canonicalBytes.copyBytes()).toString("hex")).toBe(
      "0000002f72656d6f74652d636c61772f6e61746976652d65786563757461626c652d6368756e6b2d6d616e69666573742f76310000000800000000000000010000002872656d6f74652d636c61772f66697865642d65786563757461626c652d6368756e6b696e672f7631000000075348412d323536000000080000000000100000000000080000000000000006000000207ea646958715ed687aa9ac2f5d785feb1a93411f4f25fdd6c7fcc6ab07fdf0e30000000800000000000000010000000800000000000000000000000800000000000000000000000800000000000000060000002040e6e0e877d07716240cbb732f2434f3fb1347d17f2c2d87d14804a878284f9d0000002072f7fb061560533e94c052852fe4451a390f19fa95b45c0d157e8792ccfb2116",
    );
    expect(native.manifest.chunks[0]?.chunkDigest).not.toBe(
      frontDoor.manifest.chunks[0]?.chunkDigest,
    );
  });

  it("round trips exact canonical bytes and rejects role/schema transplants", async () => {
    const artifact = await artifactForBytes(
      "listener.native_executable",
      new TextEncoder().encode("#!/bin/sh\necho measured\n"),
    );
    const bytes = artifact.canonicalBytes.copyBytes();
    expect(await decodeExecutableChunkManifest(bytes, "listener.native_executable")).toEqual(
      artifact.manifest,
    );
    expect(
      await encodeExecutableChunkManifest(artifact.manifest, "listener.native_executable"),
    ).toEqual(bytes);
    await expect(
      decodeExecutableChunkManifest(bytes, "listener.front_door_executable"),
    ).rejects.toThrow(/schemaId must equal/);
    await expect(
      parseExecutableChunkManifest(artifact.manifest, "listener.front_door_executable"),
    ).rejects.toThrow(/schemaId must equal/);
  });

  it("recomputes chunk structure and the vector digest", async () => {
    const artifact = await artifactForBytes(
      "listener.native_executable",
      new Uint8Array(NOMINAL_EXECUTABLE_CHUNK_BYTES + 3).fill(7),
    );
    const first = artifact.manifest.chunks[0];
    const second = artifact.manifest.chunks[1];
    expect(first).toMatchObject({
      chunkIndex: 0,
      byteOffset: 0,
      byteLength: NOMINAL_EXECUTABLE_CHUNK_BYTES,
    });
    expect(second).toMatchObject({
      chunkIndex: 1,
      byteOffset: NOMINAL_EXECUTABLE_CHUNK_BYTES,
      byteLength: 3,
    });

    await expect(
      parseExecutableChunkManifest(
        {
          ...artifact.manifest,
          chunks: [first, { ...second, byteOffset: 1 }],
        },
        "listener.native_executable",
      ),
    ).rejects.toThrow(/byteOffset must equal/);
    await expect(
      parseExecutableChunkManifest(
        {
          ...artifact.manifest,
          chunkVectorDigest: changedDigest(artifact.manifest.chunkVectorDigest),
        },
        "listener.native_executable",
      ),
    ).rejects.toThrow(/does not match the chunk vector/);
    await expect(
      parseExecutableChunkManifest(
        {
          ...artifact.manifest,
          chunks: artifact.manifest.chunks.slice(0, 1),
        },
        "listener.native_executable",
      ),
    ).rejects.toThrow(/must contain exactly 2 indexed entries/);
    await expect(
      parseExecutableChunkManifest(
        { ...artifact.manifest, chunkCount: 1 },
        "listener.native_executable",
      ),
    ).rejects.toThrow(/chunkCount must equal 2/);
  });

  it("rejects hostile chunk arrays before their methods can alter validation", async () => {
    const artifact = await artifactForBytes("listener.native_executable", Uint8Array.of(7));
    const onlyChunk = artifact.manifest.chunks[0];
    if (onlyChunk === undefined) throw new Error("fixture chunk is missing");
    const hostileChunks = [onlyChunk];
    Object.defineProperty(hostileChunks, "map", {
      value: () => [
        {
          ...onlyChunk,
          chunkDigest: changedDigest(onlyChunk.chunkDigest),
        },
      ],
    });

    await expect(
      parseExecutableChunkManifest(
        { ...artifact.manifest, chunks: hostileChunks },
        "listener.native_executable",
      ),
    ).rejects.toThrow(/chunks must contain exactly 1 indexed entries/);
  });

  it("rejects malformed, truncated, trailing, and oversized canonical input", async () => {
    const artifact = await artifactForBytes("listener.native_executable", Uint8Array.of(9));
    const bytes = artifact.canonicalBytes.copyBytes();
    await expect(
      decodeExecutableChunkManifest(
        bytes.subarray(0, bytes.byteLength - 1),
        "listener.native_executable",
      ),
    ).rejects.toThrow(/truncated/);
    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(bytes);
    await expect(
      decodeExecutableChunkManifest(trailing, "listener.native_executable"),
    ).rejects.toThrow(/trailing bytes/);
    await expect(
      decodeExecutableChunkManifest(
        new Uint8Array(MAX_EXECUTABLE_MANIFEST_BYTES + 1),
        "listener.native_executable",
      ),
    ).rejects.toThrow(/1\.\.65536 canonical bytes/);
    await expect(
      parseExecutableChunkManifest(
        { ...artifact.manifest, digestAlgorithm: "sha256" },
        "listener.native_executable",
      ),
    ).rejects.toThrow(/digestAlgorithm must equal SHA-256/);
  });

  it("admits content above the E1a raw-artifact cap while preserving fixed chunks", async () => {
    const bytes = new Uint8Array(16_777_216 + 1);
    bytes[0] = 1;
    bytes[bytes.byteLength - 1] = 2;
    const artifact = await artifactForBytes("listener.native_executable", bytes);
    expect(artifact.manifest.fileByteLength).toBe(16_777_217);
    expect(artifact.manifest.chunks).toHaveLength(17);
    expect(artifact.manifest.chunks[16]).toMatchObject({
      chunkIndex: 16,
      byteOffset: 16_777_216,
      byteLength: 1,
    });
    expect(artifact.commitment.byteLength).toBeLessThanOrEqual(MAX_EXECUTABLE_MANIFEST_BYTES);
  });

  it("preflights the 256 MiB source bound", async () => {
    const input = {
      role: "listener.native_executable" as const,
      fileByteLength: MAX_EXECUTABLE_BYTES + 1,
      chunkIndex: 0,
      byteOffset: 0,
      chunkBytes: new Uint8Array(),
    };
    await expect(executableChunkDigest(input)).rejects.toThrow(/must be at most 268435456/);
  });

  it("snapshots nested inputs and exposes immutable manifest/canonical snapshots", async () => {
    const source = new Uint8Array(NOMINAL_EXECUTABLE_CHUNK_BYTES + 1).fill(3);
    const pending = artifactForBytes("listener.native_executable", source);
    source.fill(4);
    const artifact = await pending;
    expect(artifact.manifest.rawFileSha256).toBe(digest(new Uint8Array(source.byteLength).fill(3)));
    expect(Object.isFrozen(artifact.manifest)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.chunks)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.chunks[0])).toBe(true);
    const firstCopy = artifact.canonicalBytes.copyBytes();
    const firstByte = firstCopy[0];
    firstCopy.fill(0);
    expect(artifact.canonicalBytes.copyBytes()[0]).toBe(firstByte);
  });

  it("keeps role/schema types correlated at compile time", () => {
    expectTypeOf<
      CanonicalExecutableManifestArtifact<"listener.native_executable">["manifest"]["schemaId"]
    >().toEqualTypeOf<typeof NATIVE_EXECUTABLE_CHUNK_MANIFEST_SCHEMA_ID>();
    expectTypeOf<
      CanonicalExecutableManifestArtifact<"listener.front_door_executable">["commitment"]["role"]
    >().toEqualTypeOf<"listener.front_door_executable">();
  });

  it("pins both E1a executable roles to the 64 KiB manifest bound", () => {
    for (const role of ["listener.native_executable", "listener.front_door_executable"] as const) {
      expect(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS[role].maxByteLength).toBe(65_536);
      expect(() =>
        parseNativeEvidenceArtifactCommitment(
          {
            role,
            artifactSchemaId: EXECUTABLE_MANIFEST_SCHEMA_BY_ROLE[role],
            artifactDigest: parseA1Digest(base64urlEncode(new Uint8Array(32))),
            byteLength: 65_537,
          },
          role,
        ),
      ).toThrow(/byteLength must be at most 65536/);
    }
  });

  it("matches the retained OpenCode executable fixture", async () => {
    const fixtureUrl = new URL(
      "../../../../../spikes/opencode-native/executable-manifest-evidence-1.17.5.json",
      import.meta.url,
    );
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
      readonly manifest: unknown;
      readonly canonicalManifestAudit: Readonly<{
        byteLength: number;
        bytesBase64url: string;
        sha256: string;
      }>;
    };
    const auditBytes = Buffer.from(fixture.canonicalManifestAudit.bytesBase64url, "base64url");
    const parsed = await decodeExecutableChunkManifest(auditBytes, "listener.native_executable");
    const artifact = await canonicalExecutableManifestArtifact(
      fixture.manifest,
      "listener.native_executable",
    );
    expect(parsed).toEqual(artifact.manifest);
    expect(Buffer.from(artifact.canonicalBytes.copyBytes())).toEqual(auditBytes);
    expect(auditBytes).toHaveLength(11_026);
    expect(fixture.canonicalManifestAudit.byteLength).toBe(11_026);
    expect(createHash("sha256").update(auditBytes).digest("hex")).toBe(
      "54dcae0f611f2ebe8e91531c73d475f1e2aaf1ea57304e9e0b5aca1ac03e3af8",
    );
    expect(fixture.canonicalManifestAudit.sha256).toBe(
      "54dcae0f611f2ebe8e91531c73d475f1e2aaf1ea57304e9e0b5aca1ac03e3af8",
    );
    expect(artifact.manifest.chunkVectorDigest).toBe("d14lrmnOFib3qvN7y_d0NqAoApcwv8YugDaN_Q1eDOM");
    expect(artifact.manifest).toMatchObject({
      fileByteLength: 156_412_048,
      rawFileSha256: "_hg5rFxBfF_EoI3SaEZZB8PoxsoV5__ZPzqNxG1j0zk",
      chunkCount: 150,
    });
    expect(artifact.manifest.chunks).toHaveLength(150);
    expect(artifact.manifest.chunks[149]).toEqual({
      chunkIndex: 149,
      byteOffset: 156_237_824,
      byteLength: 174_224,
      chunkDigest: "xIksXYgFjfvcCYKoR-MduYhM2e7gzoVNQJqUT6O19EE",
    });
    expect(artifact.commitment.artifactDigest).toBe("VNyuD2EfLr6OkVMcc9R18eKq8epXME6eC1rKGsA-Ovg");
  });
});
