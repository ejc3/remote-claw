import { base64urlDecode, base64urlEncode, CanonicalWriter } from "@remote-claw/clawsec";
import { describe, expect, expectTypeOf, it } from "vitest";
import { parseA1CanonicalId, parseA1Digest, parseA1SafeId } from "./ids.js";
import {
  encodeNativeWorkspaceBindingInput,
  NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS,
  NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
  NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
  NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
  type NativeBindingAuthorityArtifactRole,
  type NativeWorkspaceBindingInputV1,
  parseNativeEvidenceArtifactCommitment,
} from "./native-binding-authority-evidence.js";
import {
  CANONICAL_DIRECTORY_PATH_DIGEST_DOMAIN,
  type CanonicalWorkspaceEvidenceBundleInput,
  canonicalDirectoryPathDigest,
  canonicalLinuxAllowedRootAncestryArtifact,
  canonicalLinuxMountNamespaceIdentityArtifact,
  canonicalLinuxNoFollowFilesystemIdentityArtifact,
  canonicalPosixCanonicalDirectoryEvidenceArtifact,
  decodeLinuxAllowedRootAncestry,
  decodeLinuxMountNamespaceIdentity,
  decodeLinuxNoFollowFilesystemIdentity,
  decodePosixCanonicalDirectoryEvidence,
  encodeLinuxAllowedRootAncestry,
  encodeLinuxMountNamespaceIdentity,
  encodeLinuxNoFollowFilesystemIdentity,
  encodePosixCanonicalDirectoryEvidence,
  LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
  LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY,
  LINUX_DIRECTORY_FILE_KIND,
  LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
  LINUX_MOUNT_NAMESPACE_KIND,
  LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
  LINUX_NSFS_MAGIC_DECIMAL,
  MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES,
  MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES,
  MAX_WORKSPACE_PATH_COMPONENTS,
  POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
  parseLinuxAllowedRootAncestry,
  parseLinuxMountNamespaceIdentity,
  parseLinuxNoFollowFilesystemIdentity,
  parsePosixAbsoluteDirectory,
  parsePosixCanonicalDirectoryEvidence,
  parseU64Decimal,
  u64DecimalFromBigInt,
  verifyCanonicalWorkspaceEvidenceBundle,
} from "./native-binding-authority-workspace-evidence.js";

function encoded(byteLength: number, fill: number): string {
  return base64urlEncode(new Uint8Array(byteLength).fill(fill));
}

const RUNTIME_ID = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 1)}`);
const OTHER_RUNTIME_ID = parseA1CanonicalId("nativeRuntime", `rcrt_${encoded(32, 9)}`);
const PROJECT_ID = parseA1CanonicalId("project", `rcpj_${encoded(16, 2)}`);
const WORKSPACE_BINDING_ID = parseA1CanonicalId("nativeWorkspaceBinding", `nwb_${encoded(16, 3)}`);
const NATIVE_WORKSPACE_ID = parseA1SafeId("opencode-workspace-1");
const EXT4_MAGIC = "61267" as const;

function entry(
  index: number,
  component: string,
  directoryDevice: string,
  directoryInode: string,
  mountId: string,
  filesystemMagic = EXT4_MAGIC,
) {
  return { index, component, directoryDevice, directoryInode, mountId, filesystemMagic };
}

async function fixture(
  options: {
    nativeWorkspaceId?: NativeWorkspaceBindingInputV1["nativeWorkspaceId"];
    runtimeId?: string;
    nativeIncarnation?: number;
    finalEntry?: ReturnType<typeof entry>;
  } = {},
) {
  const runtimeId = options.runtimeId ?? RUNTIME_ID;
  const nativeIncarnation = options.nativeIncarnation ?? 7;
  const mountNamespace = await canonicalLinuxMountNamespaceIdentityArtifact({
    schemaId: LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
    schemaVersion: 1,
    runtimeId,
    nativeIncarnation,
    namespaceKind: LINUX_MOUNT_NAMESPACE_KIND,
    bootId: "00112233-4455-6677-8899-aabbccddeeff",
    namespaceDevice: "0",
    namespaceInode: "18446744073709551615",
    namespaceFilesystemMagic: LINUX_NSFS_MAGIC_DECIMAL,
  });
  const canonicalDirectoryPathDigestValue = await canonicalDirectoryPathDigest("/srv/workspace");
  const canonicalDirectory = await canonicalPosixCanonicalDirectoryEvidenceArtifact({
    schemaId: POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
    schemaVersion: 1,
    runtimeId,
    nativeIncarnation,
    directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
    mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
    canonicalDirectory: "/srv/workspace",
    canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
  });
  const selectedFinalEntry =
    options.finalEntry ?? entry(2, "workspace", "18446744073709551615", "99", "42", EXT4_MAGIC);
  const filesystemIdentity = await canonicalLinuxNoFollowFilesystemIdentityArtifact({
    schemaId: LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
    schemaVersion: 1,
    runtimeId,
    nativeIncarnation,
    mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
    canonicalDirectoryArtifactDigest: canonicalDirectory.commitment.artifactDigest,
    canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
    fileKind: LINUX_DIRECTORY_FILE_KIND,
    directoryDevice: "18446744073709551615",
    directoryInode: "99",
    mountId: "42",
    filesystemMagic: EXT4_MAGIC,
  });
  const rootEntry = entry(0, "/", "10", "2", "1");
  const allowedFinalEntry = entry(1, "srv", "20", "3", "42");
  const allowedRoot = await canonicalLinuxAllowedRootAncestryArtifact({
    schemaId: LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
    schemaVersion: 1,
    runtimeId,
    nativeIncarnation,
    mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
    canonicalDirectoryArtifactDigest: canonicalDirectory.commitment.artifactDigest,
    filesystemIdentityArtifactDigest: filesystemIdentity.commitment.artifactDigest,
    suffixMountPolicy: LINUX_ALLOWED_ROOT_SUFFIX_MOUNT_POLICY,
    allowedRoot: "/srv",
    allowedRootPathDigest: await canonicalDirectoryPathDigest("/srv"),
    canonicalDirectoryPathDigest: canonicalDirectoryPathDigestValue,
    allowedRootEntryCount: 2,
    allowedRootEntries: [rootEntry, allowedFinalEntry],
    targetEntryCount: 3,
    targetEntries: [{ ...rootEntry }, { ...allowedFinalEntry }, selectedFinalEntry],
  });
  const parent: NativeWorkspaceBindingInputV1 = {
    schemaId: NATIVE_WORKSPACE_BINDING_INPUT_SCHEMA_ID,
    schemaVersion: 1,
    nativeWorkspaceBindingId: WORKSPACE_BINDING_ID,
    runtimeId: parseA1CanonicalId("nativeRuntime", runtimeId),
    nativeIncarnation,
    projectId: PROJECT_ID,
    nativeWorkspaceId: options.nativeWorkspaceId ?? null,
    directoryNormalizationSchemaId: NATIVE_DIRECTORY_NORMALIZATION_SCHEMA_ID,
    filesystemIdentitySchemaId: NATIVE_FILESYSTEM_IDENTITY_SCHEMA_ID,
    workspaceGeneration: 1,
    artifacts: [
      canonicalDirectory.commitment,
      filesystemIdentity.commitment,
      allowedRoot.commitment,
      mountNamespace.commitment,
    ],
  };
  const workspaceParentBytes = encodeNativeWorkspaceBindingInput(parent);
  const input: CanonicalWorkspaceEvidenceBundleInput = {
    mountNamespaceBytes: mountNamespace.canonicalBytes.copyBytes(),
    canonicalDirectoryBytes: canonicalDirectory.canonicalBytes.copyBytes(),
    filesystemIdentityBytes: filesystemIdentity.canonicalBytes.copyBytes(),
    allowedRootBytes: allowedRoot.canonicalBytes.copyBytes(),
    workspaceParentBytes,
  };
  return {
    mountNamespace,
    canonicalDirectory,
    filesystemIdentity,
    allowedRoot,
    parent,
    input,
  };
}

function appendByte(value: Uint8Array, byte: number): Uint8Array {
  const result = new Uint8Array(value.byteLength + 1);
  result.set(value);
  result[value.byteLength] = byte;
  return result;
}

function rawU64(value: string): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

describe("native binding workspace evidence codecs", () => {
  it("locks the M -> P -> F -> A and E1a parent byte vectors", async () => {
    const selected = await fixture();
    const result = await verifyCanonicalWorkspaceEvidenceBundle(selected.input);
    expect({
      pathDomain: CANONICAL_DIRECTORY_PATH_DIGEST_DOMAIN,
      pathDigest: result.canonicalDirectory.evidence.canonicalDirectoryPathDigest,
      mountBytes: base64urlEncode(selected.input.mountNamespaceBytes),
      mountDigest: result.mountNamespace.commitment.artifactDigest,
      canonicalDirectoryBytes: base64urlEncode(selected.input.canonicalDirectoryBytes),
      canonicalDirectoryDigest: result.canonicalDirectory.commitment.artifactDigest,
      filesystemBytes: base64urlEncode(selected.input.filesystemIdentityBytes),
      filesystemDigest: result.filesystemIdentity.commitment.artifactDigest,
      allowedRootBytes: base64urlEncode(selected.input.allowedRootBytes),
      allowedRootDigest: result.allowedRoot.commitment.artifactDigest,
      parentBytes: base64urlEncode(selected.input.workspaceParentBytes),
      workspaceInputDigest: result.workspaceInputDigest,
    }).toEqual({
      pathDomain: CANONICAL_DIRECTORY_PATH_DIGEST_DOMAIN,
      pathDigest: "9rY8ujfu-A8V-_Q9ixCRX7G2xSm5SsLTpxXdBYv-RpM",
      mountBytes:
        "AAAALXJlbW90ZS1jbGF3L2xpbnV4LW1vdW50LW5hbWVzcGFjZS1pZGVudGl0eS92MQAAAAgAAAAAAAAAAQAAADByY3J0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUAAAAIAAAAAAAAAAcAAAADbW50AAAAJDAwMTEyMjMzLTQ0NTUtNjY3Ny04ODk5LWFhYmJjY2RkZWVmZgAAAAgAAAAAAAAAAAAAAAj__________wAAAAgAAAAAbnNmcw",
      mountDigest: "DfFr6U8YkvqdaxdDQwYnH_X2OtEf0sx46ehS86bEq-k",
      canonicalDirectoryBytes:
        "AAAAMXJlbW90ZS1jbGF3L3Bvc2l4LWNhbm9uaWNhbC1kaXJlY3RvcnktZXZpZGVuY2UvdjEAAAAIAAAAAAAAAAEAAAAwcmNydF9BUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFAAAACAAAAAAAAAAHAAAANXJlbW90ZS1jbGF3L3Bvc2l4LWFic29sdXRlLWRpcmVjdG9yeS1ub3JtYWxpemF0aW9uL3YxAAAAIA3xa-lPGJL6nWsXQ0MGJx_19jrRH9LMeOnoUvOmxKvpAAAADi9zcnYvd29ya3NwYWNlAAAAIPa2PLo37vgPFfv0PYsQkV-xtsUpuUrC06cV3QWL_kaT",
      canonicalDirectoryDigest: "7WCyWSdEpcP8eUTvh1YuQzitbMWQ4NStSWH1qo9JtjU",
      filesystemBytes:
        "AAAAMnJlbW90ZS1jbGF3L2xpbnV4LW5vLWZvbGxvdy1maWxlc3lzdGVtLWlkZW50aXR5L3YxAAAACAAAAAAAAAABAAAAMHJjcnRfQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRQAAAAgAAAAAAAAABwAAACAN8WvpTxiS-p1rF0NDBicf9fY60R_SzHjp6FLzpsSr6QAAACDtYLJZJ0Slw_x5RO-HVi5DOK1sxZDg1K1JYfWqj0m2NQAAACD2tjy6N-74DxX79D2LEJFfsbbFKblKwtOnFd0Fi_5GkwAAAAlkaXJlY3RvcnkAAAAI__________8AAAAIAAAAAAAAAGMAAAAIAAAAAAAAACoAAAAIAAAAAAAA71M",
      filesystemDigest: "xNQ8Jeq065y9b5wnAFW_C0X-_SNnPPHK7o9VInP7fy0",
      allowedRootBytes:
        "AAAAKnJlbW90ZS1jbGF3L2xpbnV4LWFsbG93ZWQtcm9vdC1hbmNlc3RyeS92MQAAAAgAAAAAAAAAAQAAADByY3J0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUAAAAIAAAAAAAAAAcAAAAgDfFr6U8YkvqdaxdDQwYnH_X2OtEf0sx46ehS86bEq-kAAAAg7WCyWSdEpcP8eUTvh1YuQzitbMWQ4NStSWH1qo9JtjUAAAAgxNQ8Jeq065y9b5wnAFW_C0X-_SNnPPHK7o9VInP7fy0AAAAac2FtZV9tb3VudF9hc19hbGxvd2VkX3Jvb3QAAAAEL3NydgAAACCEQycT0Kc_4FIOoprPoGY-ZQafppgRI2ZAUlSFAb3qvgAAACD2tjy6N-74DxX79D2LEJFfsbbFKblKwtOnFd0Fi_5GkwAAAAgAAAAAAAAAAgAAAAgAAAAAAAAAAAAAAAEvAAAACAAAAAAAAAAKAAAACAAAAAAAAAACAAAACAAAAAAAAAABAAAACAAAAAAAAO9TAAAACAAAAAAAAAABAAAAA3NydgAAAAgAAAAAAAAAFAAAAAgAAAAAAAAAAwAAAAgAAAAAAAAAKgAAAAgAAAAAAADvUwAAAAgAAAAAAAAAAwAAAAgAAAAAAAAAAAAAAAEvAAAACAAAAAAAAAAKAAAACAAAAAAAAAACAAAACAAAAAAAAAABAAAACAAAAAAAAO9TAAAACAAAAAAAAAABAAAAA3NydgAAAAgAAAAAAAAAFAAAAAgAAAAAAAAAAwAAAAgAAAAAAAAAKgAAAAgAAAAAAADvUwAAAAgAAAAAAAAAAgAAAAl3b3Jrc3BhY2UAAAAI__________8AAAAIAAAAAAAAAGMAAAAIAAAAAAAAACoAAAAIAAAAAAAA71M",
      allowedRootDigest: "YQVJ_wxkzC7y4yOpV3RMiw-xvkyvAHgD5Oww7MLDTY8",
      parentBytes:
        "AAAALXJlbW90ZS1jbGF3L25hdGl2ZS13b3Jrc3BhY2UtYmluZGluZy1pbnB1dC92MQAAAAgAAAAAAAAAAQAAABpud2JfQXdNREF3TURBd01EQXdNREF3TURBdwAAADByY3J0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUUAAAAIAAAAAAAAAAcAAAAbcmNwal9BZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnAAAAADVyZW1vdGUtY2xhdy9wb3NpeC1hYnNvbHV0ZS1kaXJlY3Rvcnktbm9ybWFsaXphdGlvbi92MQAAADJyZW1vdGUtY2xhdy9saW51eC1uby1mb2xsb3ctZmlsZXN5c3RlbS1pZGVudGl0eS92MQAAAAgAAAAAAAAAAQAAAAgAAAAAAAAABAAAAB13b3Jrc3BhY2UuY2Fub25pY2FsX2RpcmVjdG9yeQAAADFyZW1vdGUtY2xhdy9wb3NpeC1jYW5vbmljYWwtZGlyZWN0b3J5LWV2aWRlbmNlL3YxAAAAIO1gslknRKXD_HlE74dWLkM4rWzFkODUrUlh9aqPSbY1AAAACAAAAAAAAAEUAAAAHXdvcmtzcGFjZS5maWxlc3lzdGVtX2lkZW50aXR5AAAAMnJlbW90ZS1jbGF3L2xpbnV4LW5vLWZvbGxvdy1maWxlc3lzdGVtLWlkZW50aXR5L3YxAAAAIMTUPCXqtOucvW-cJwBVvwtF_v0jZzzxyu6PVSJz-38tAAAACAAAAAAAAAErAAAAFndvcmtzcGFjZS5hbGxvd2VkX3Jvb3QAAAAqcmVtb3RlLWNsYXcvbGludXgtYWxsb3dlZC1yb290LWFuY2VzdHJ5L3YxAAAAIGEFSf8MZMwu8uMjqVd0TIsPsb5MrwB4A-TsMOzCw02PAAAACAAAAAAAAAK9AAAAGXdvcmtzcGFjZS5tb3VudF9uYW1lc3BhY2UAAAAtcmVtb3RlLWNsYXcvbGludXgtbW91bnQtbmFtZXNwYWNlLWlkZW50aXR5L3YxAAAAIA3xa-lPGJL6nWsXQ0MGJx_19jrRH9LMeOnoUvOmxKvpAAAACAAAAAAAAADQ",
      workspaceInputDigest: "6C9P4Cm1qYbU2bPvVytOCzaIapBRrEbM2126T1hpxBI",
    });
  });

  it("round trips each strict codec and preserves exact role-correlated types", async () => {
    const selected = await fixture();
    const mount = decodeLinuxMountNamespaceIdentity(selected.input.mountNamespaceBytes);
    const directory = await decodePosixCanonicalDirectoryEvidence(
      selected.input.canonicalDirectoryBytes,
    );
    const filesystem = decodeLinuxNoFollowFilesystemIdentity(
      selected.input.filesystemIdentityBytes,
    );
    const allowedRoot = await decodeLinuxAllowedRootAncestry(selected.input.allowedRootBytes);

    expect(encodeLinuxMountNamespaceIdentity(mount)).toEqual(selected.input.mountNamespaceBytes);
    expect(await encodePosixCanonicalDirectoryEvidence(directory)).toEqual(
      selected.input.canonicalDirectoryBytes,
    );
    expect(encodeLinuxNoFollowFilesystemIdentity(filesystem)).toEqual(
      selected.input.filesystemIdentityBytes,
    );
    expect(await encodeLinuxAllowedRootAncestry(allowedRoot)).toEqual(
      selected.input.allowedRootBytes,
    );
    expectTypeOf(
      selected.mountNamespace.commitment.role,
    ).toEqualTypeOf<"workspace.mount_namespace">();
    expectTypeOf(selected.canonicalDirectory.commitment.artifactSchemaId).toEqualTypeOf<
      typeof POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID
    >();
    expectTypeOf(selected.filesystemIdentity.evidence.directoryDevice).toEqualTypeOf<
      ReturnType<typeof parseU64Decimal>
    >();
    expect(Object.isFrozen(allowedRoot)).toBe(true);
    expect(Object.isFrozen(allowedRoot.allowedRootEntries)).toBe(true);
    expect(Object.isFrozen(allowedRoot.targetEntries[0])).toBe(true);
  });

  it("represents every kernel u64 exactly and rejects noncanonical decimal forms", async () => {
    expect(parseU64Decimal("0")).toBe("0");
    expect(parseU64Decimal("18446744073709551615")).toBe("18446744073709551615");
    expect(u64DecimalFromBigInt(18_446_744_073_709_551_615n)).toBe("18446744073709551615");
    for (const invalid of [
      0,
      1,
      -1,
      "",
      "00",
      "01",
      "+1",
      "-1",
      "1.0",
      " 1",
      "18446744073709551616",
      "999999999999999999999",
    ]) {
      expect(() => parseU64Decimal(invalid)).toThrow(/unsigned 64-bit decimal/);
    }
    expect(() => u64DecimalFromBigInt(-1n)).toThrow(/unsigned 64-bit bigint/);
    expect(() => u64DecimalFromBigInt(18_446_744_073_709_551_616n)).toThrow(
      /unsigned 64-bit bigint/,
    );

    const selected = await fixture();
    expect(selected.mountNamespace.evidence.namespaceInode).toBe("18446744073709551615");
    expect(selected.filesystemIdentity.evidence.directoryDevice).toBe("18446744073709551615");
    expect(() =>
      parseLinuxNoFollowFilesystemIdentity({
        ...selected.filesystemIdentity.evidence,
        filesystemMagic: "4294967296",
      }),
    ).toThrow(/unsigned 32-bit/);
    expect(() =>
      parseLinuxNoFollowFilesystemIdentity({
        ...selected.filesystemIdentity.evidence,
        directoryInode: "0",
      }),
    ).toThrow(/greater than zero/);
  });

  it("enforces the exact POSIX path grammar without normalizing ordinary bytes", () => {
    const ordinary = "/é space/%raw\\colon:line\nend";
    expect(parsePosixAbsoluteDirectory(ordinary)).toEqual({
      path: ordinary,
      components: ["é space", "%raw\\colon:line\nend"],
    });
    expect(parsePosixAbsoluteDirectory("/")).toEqual({ path: "/", components: [] });
    const maxComponent = "a".repeat(MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES);
    expect(parsePosixAbsoluteDirectory(`/${maxComponent}`).components).toEqual([maxComponent]);
    const maxComponents = `/${Array.from({ length: MAX_WORKSPACE_PATH_COMPONENTS }, () => "a").join("/")}`;
    expect(parsePosixAbsoluteDirectory(maxComponents).components).toHaveLength(
      MAX_WORKSPACE_PATH_COMPONENTS,
    );
    const exact4095 = `/${[
      ...Array.from({ length: 15 }, () => "a".repeat(255)),
      "b".repeat(254),
    ].join("/")}`;
    const exact4096 = `/${Array.from({ length: 16 }, () => "a".repeat(255)).join("/")}`;
    expect(new TextEncoder().encode(exact4095)).toHaveLength(4_095);
    expect(parsePosixAbsoluteDirectory(exact4095).path).toBe(exact4095);
    expect(new TextEncoder().encode(exact4096)).toHaveLength(4_096);
    expect(() => parsePosixAbsoluteDirectory(exact4096)).toThrow(/1\.\.4095 UTF-8 bytes/);

    const scalar252 = "😀".repeat(63);
    const scalar256 = "😀".repeat(64);
    expect(new TextEncoder().encode(scalar252)).toHaveLength(252);
    expect(parsePosixAbsoluteDirectory(`/${scalar252}`).components).toEqual([scalar252]);
    expect(() => parsePosixAbsoluteDirectory(`/${scalar256}`)).toThrow(/at most 255 UTF-8 bytes/);

    for (const invalid of [
      "",
      "relative",
      "//",
      "/a//b",
      "/a/",
      "/.",
      "/..",
      "/a/./b",
      "/a/../b",
      "/nul\0byte",
      "/\ud800",
      "/\udc00",
      `/${"a".repeat(MAX_WORKSPACE_PATH_COMPONENT_UTF8_BYTES + 1)}`,
      `/${Array.from({ length: MAX_WORKSPACE_PATH_COMPONENTS + 1 }, () => "a").join("/")}`,
      `/${"a".repeat(4_094)}`,
    ]) {
      expect(() => parsePosixAbsoluteDirectory(invalid)).toThrow();
    }
  });

  it("keeps NFC and NFD paths byte-distinct", async () => {
    const nfc = "/café";
    const nfd = "/café";
    expect(parsePosixAbsoluteDirectory(nfc).path).not.toBe(parsePosixAbsoluteDirectory(nfd).path);
    expect(await canonicalDirectoryPathDigest(nfc)).not.toBe(
      await canonicalDirectoryPathDigest(nfd),
    );
  });

  it("rejects wrong leaf literals, exact-record violations, and invalid boot identities", async () => {
    const selected = await fixture();
    expect(() =>
      parseLinuxMountNamespaceIdentity({
        ...selected.mountNamespace.evidence,
        namespaceKind: "net",
      }),
    ).toThrow(/namespaceKind must equal/);
    expect(() =>
      parseLinuxMountNamespaceIdentity({
        ...selected.mountNamespace.evidence,
        bootId: "00112233-4455-6677-8899-AABBCCDDEEFF",
      }),
    ).toThrow(/lowercase UUID/);
    expect(() =>
      parseLinuxMountNamespaceIdentity({
        ...selected.mountNamespace.evidence,
        namespaceFilesystemMagic: "1",
      }),
    ).toThrow(/must equal 1853056627/);
    expect(() =>
      parseLinuxMountNamespaceIdentity({
        ...selected.mountNamespace.evidence,
        extra: true,
      }),
    ).toThrow(/exactly the selected fields/);
    const accessor = { ...selected.mountNamespace.evidence };
    Object.defineProperty(accessor, "runtimeId", { get: () => RUNTIME_ID, enumerable: true });
    expect(() => parseLinuxMountNamespaceIdentity(accessor)).toThrow(/own data properties/);
    await expect(
      parsePosixCanonicalDirectoryEvidence({
        ...selected.canonicalDirectory.evidence,
        canonicalDirectoryPathDigest: parseA1Digest(encoded(32, 88)),
      }),
    ).rejects.toThrow(/does not match canonicalDirectory/);
    expect(() =>
      parseLinuxNoFollowFilesystemIdentity({
        ...selected.filesystemIdentity.evidence,
        fileKind: "file",
      }),
    ).toThrow(/fileKind must equal/);
  });

  it("enforces ancestry reconstruction, overlap, containment, and the suffix mount policy", async () => {
    const selected = await fixture();
    const evidence = selected.allowedRoot.evidence;
    await expect(
      parseLinuxAllowedRootAncestry({ ...evidence, targetEntryCount: 2 }),
    ).rejects.toThrow(/exactly 2 indexed entries/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        targetEntries: evidence.targetEntries.map((item, index) =>
          index === 1 ? { ...item, index: 9 } : item,
        ),
      }),
    ).rejects.toThrow(/index must equal 1/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        allowedRootEntries: evidence.allowedRootEntries.map((item, index) =>
          index === 1 ? { ...item, index: 9 } : item,
        ),
      }),
    ).rejects.toThrow(/index must equal 1/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        targetEntries: evidence.targetEntries.map((item, index) =>
          index === 1 ? { ...item, directoryInode: "4" } : item,
        ),
      }),
    ).rejects.toThrow(/overlapping allowed-root entry/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        targetEntries: evidence.targetEntries.map((item, index) =>
          index === 2 ? { ...item, mountId: "43" } : item,
        ),
      }),
    ).rejects.toThrow(/allowed root mountId/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        allowedRoot: "/other",
        allowedRootPathDigest: await canonicalDirectoryPathDigest("/other"),
        allowedRootEntries: evidence.allowedRootEntries.map((item, index) =>
          index === 1 ? { ...item, component: "other" } : item,
        ),
      }),
    ).rejects.toThrow(/component prefix/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        canonicalDirectoryPathDigest: parseA1Digest(encoded(32, 89)),
      }),
    ).rejects.toThrow(/does not match targetEntries/);
  });

  it("accepts inclusive and root allowed roots but rejects string-prefix confusion", async () => {
    const selected = await fixture();
    const evidence = selected.allowedRoot.evidence;
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        allowedRoot: "/srv/workspace",
        allowedRootPathDigest: evidence.canonicalDirectoryPathDigest,
        allowedRootEntryCount: 3,
        allowedRootEntries: evidence.targetEntries.map((item) => ({ ...item })),
      }),
    ).resolves.toMatchObject({ allowedRoot: "/srv/workspace", allowedRootEntryCount: 3 });

    const rootMountedTarget = evidence.targetEntries.map((item) => ({ ...item, mountId: "1" }));
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        allowedRoot: "/",
        allowedRootPathDigest: await canonicalDirectoryPathDigest("/"),
        allowedRootEntryCount: 1,
        allowedRootEntries: [{ ...rootMountedTarget[0] }],
        targetEntries: rootMountedTarget,
      }),
    ).resolves.toMatchObject({ allowedRoot: "/", allowedRootEntryCount: 1 });

    const prefixConfusionEntries = [
      { ...evidence.targetEntries[0] },
      { ...evidence.targetEntries[1], component: "srv2" },
      { ...evidence.targetEntries[2] },
    ];
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        canonicalDirectoryPathDigest: await canonicalDirectoryPathDigest("/srv2/workspace"),
        targetEntries: prefixConfusionEntries,
      }),
    ).rejects.toThrow(/overlapping allowed-root entry|component prefix/);
  });

  it("rejects hostile ancestry arrays and malformed reconstructed root/components", async () => {
    const selected = await fixture();
    const evidence = selected.allowedRoot.evidence;
    const hole = new Array(2);
    hole[0] = evidence.allowedRootEntries[0];
    await expect(
      parseLinuxAllowedRootAncestry({ ...evidence, allowedRootEntries: hole }),
    ).rejects.toThrow(/exactly 2 indexed entries/);

    const symbolArray = evidence.allowedRootEntries.map((item) => ({ ...item }));
    Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
    await expect(
      parseLinuxAllowedRootAncestry({ ...evidence, allowedRootEntries: symbolArray }),
    ).rejects.toThrow(/exactly 2 indexed entries/);

    const accessorArray = evidence.targetEntries.map((item) => ({ ...item }));
    Object.defineProperty(accessorArray, "1", {
      get: () => evidence.targetEntries[1],
      enumerable: true,
      configurable: true,
    });
    await expect(
      parseLinuxAllowedRootAncestry({ ...evidence, targetEntries: accessorArray }),
    ).rejects.toThrow(/own indexed data properties/);

    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        targetEntries: evidence.targetEntries.map((item, index) =>
          index === 0 ? { ...item, component: "root" } : item,
        ),
      }),
    ).rejects.toThrow(/must equal "\/"/);
    await expect(
      parseLinuxAllowedRootAncestry({
        ...evidence,
        targetEntries: evidence.targetEntries.map((item, index) =>
          index === 2 ? { ...item, component: "work/space" } : item,
        ),
      }),
    ).rejects.toThrow(/one exact POSIX path component/);
  });

  it("rejects truncation, trailing bytes, malformed UTF-8, bad field lengths, and oversized A", async () => {
    const selected = await fixture();
    expect(() =>
      decodeLinuxMountNamespaceIdentity(selected.input.mountNamespaceBytes.slice(0, -1)),
    ).toThrow(/truncated/);
    expect(() =>
      decodeLinuxNoFollowFilesystemIdentity(appendByte(selected.input.filesystemIdentityBytes, 0)),
    ).toThrow(/trailing bytes/);
    const malformed = selected.input.canonicalDirectoryBytes.slice();
    malformed[4] = 0xff;
    await expect(decodePosixCanonicalDirectoryEvidence(malformed)).rejects.toThrow(
      /canonical UTF-8/,
    );
    const writer = new CanonicalWriter();
    writer.str(LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID);
    writer.uint(1);
    writer.str(RUNTIME_ID);
    writer.uint(7);
    writer.str(LINUX_MOUNT_NAMESPACE_KIND);
    writer.str("00112233-4455-6677-8899-aabbccddeeff");
    writer.bytes(Uint8Array.of(0));
    expect(() => decodeLinuxMountNamespaceIdentity(writer.finish())).toThrow(/exactly 8 bytes/);
    await expect(
      decodeLinuxAllowedRootAncestry(new Uint8Array(MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES + 1)),
    ).rejects.toThrow(/canonical bytes/);
  });

  it("rejects ancestry counts above 257 before reading attacker-selected rows", async () => {
    const selected = await fixture();
    const evidence = selected.allowedRoot.evidence;
    const oversizedVector = (selectedVector: "allowed" | "target") => {
      const writer = new CanonicalWriter();
      writer.str(evidence.schemaId);
      writer.uint(evidence.schemaVersion);
      writer.str(evidence.runtimeId);
      writer.uint(evidence.nativeIncarnation);
      writer.bytes(base64urlDecode(evidence.mountNamespaceArtifactDigest));
      writer.bytes(base64urlDecode(evidence.canonicalDirectoryArtifactDigest));
      writer.bytes(base64urlDecode(evidence.filesystemIdentityArtifactDigest));
      writer.str(evidence.suffixMountPolicy);
      writer.str(evidence.allowedRoot);
      writer.bytes(base64urlDecode(evidence.allowedRootPathDigest));
      writer.bytes(base64urlDecode(evidence.canonicalDirectoryPathDigest));
      if (selectedVector === "allowed") {
        writer.uint(258);
        return writer.finish();
      }
      writer.uint(1);
      const root = evidence.allowedRootEntries[0];
      if (root === undefined) throw new Error("fixture root entry is missing");
      writer.uint(root.index);
      writer.str(root.component);
      writer.bytes(rawU64(root.directoryDevice));
      writer.bytes(rawU64(root.directoryInode));
      writer.bytes(rawU64(root.mountId));
      writer.bytes(rawU64(root.filesystemMagic));
      writer.uint(258);
      return writer.finish();
    };
    for (const selectedVector of ["allowed", "target"] as const) {
      await expect(decodeLinuxAllowedRootAncestry(oversizedVector(selectedVector))).rejects.toThrow(
        /at most 257/,
      );
    }
  });

  it("verifies the exact raw-byte DAG, parent commitments, and derived workspace slot", async () => {
    const selected = await fixture();
    const bundle = await verifyCanonicalWorkspaceEvidenceBundle(selected.input);
    expect(Object.keys(bundle)).toEqual([
      "mountNamespace",
      "canonicalDirectory",
      "filesystemIdentity",
      "allowedRoot",
      "workspaceParent",
      "workspaceSlot",
      "workspaceInputDigest",
    ]);
    expect(bundle.workspaceSlot).toEqual({
      kind: "canonical_directory_path_digest",
      value: bundle.canonicalDirectory.evidence.canonicalDirectoryPathDigest,
    });
    expect(bundle.workspaceParent.input).toEqual(selected.parent);
    expect(bundle.workspaceParent.commitment.artifactDigest).toBe(bundle.workspaceInputDigest);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.mountNamespace)).toBe(true);

    const native = await fixture({ nativeWorkspaceId: NATIVE_WORKSPACE_ID });
    await expect(verifyCanonicalWorkspaceEvidenceBundle(native.input)).resolves.toMatchObject({
      workspaceSlot: { kind: "native_workspace_id", value: NATIVE_WORKSPACE_ID },
    });
  });

  it("rejects every broken M -> P -> F -> A dependency and cross-leaf transplant", async () => {
    const selected = await fixture();
    const wrongDigest = parseA1Digest(encoded(32, 77));
    const wrongDirectory = await canonicalPosixCanonicalDirectoryEvidenceArtifact({
      ...selected.canonicalDirectory.evidence,
      mountNamespaceArtifactDigest: wrongDigest,
    });
    const filesystemCases = [
      ["mountNamespaceArtifactDigest", /filesystemIdentity\.mountNamespaceArtifactDigest/],
      ["canonicalDirectoryArtifactDigest", /filesystemIdentity\.canonicalDirectoryArtifactDigest/],
      ["canonicalDirectoryPathDigest", /filesystemIdentity\.canonicalDirectoryPathDigest/],
    ] as const;
    const allowedRootCases = [
      ["mountNamespaceArtifactDigest", /allowedRoot\.mountNamespaceArtifactDigest/],
      ["canonicalDirectoryArtifactDigest", /allowedRoot\.canonicalDirectoryArtifactDigest/],
      ["filesystemIdentityArtifactDigest", /allowedRoot\.filesystemIdentityArtifactDigest/],
    ] as const;
    const cases: Array<readonly [keyof CanonicalWorkspaceEvidenceBundleInput, Uint8Array, RegExp]> =
      [
        [
          "canonicalDirectoryBytes",
          wrongDirectory.canonicalBytes.copyBytes(),
          /canonicalDirectory\.mountNamespaceArtifactDigest/,
        ],
      ];
    for (const [field, pattern] of filesystemCases) {
      const artifact = await canonicalLinuxNoFollowFilesystemIdentityArtifact({
        ...selected.filesystemIdentity.evidence,
        [field]: wrongDigest,
      });
      cases.push(["filesystemIdentityBytes", artifact.canonicalBytes.copyBytes(), pattern]);
    }
    for (const [field, pattern] of allowedRootCases) {
      const artifact = await canonicalLinuxAllowedRootAncestryArtifact({
        ...selected.allowedRoot.evidence,
        [field]: wrongDigest,
      });
      cases.push(["allowedRootBytes", artifact.canonicalBytes.copyBytes(), pattern]);
    }
    for (const [field, bytes, pattern] of cases) {
      await expect(
        verifyCanonicalWorkspaceEvidenceBundle({ ...selected.input, [field]: bytes }),
      ).rejects.toThrow(pattern);
    }
    await expect(
      verifyCanonicalWorkspaceEvidenceBundle({
        ...selected.input,
        canonicalDirectoryBytes: selected.input.filesystemIdentityBytes,
      }),
    ).rejects.toThrow(/schemaId must equal|canonical UTF-8/);
  });

  it("rejects a final identity mismatch and every parent digest/length/order mismatch", async () => {
    const selected = await fixture();
    const wrongDigest = parseA1Digest(encoded(32, 77));

    const finalMismatch = await fixture({
      finalEntry: entry(2, "workspace", "18446744073709551615", "100", "42"),
    });
    await expect(verifyCanonicalWorkspaceEvidenceBundle(finalMismatch.input)).rejects.toThrow(
      /targetEntries\.final\.directoryInode/,
    );

    for (let selectedIndex = 0; selectedIndex < selected.parent.artifacts.length; selectedIndex++) {
      for (const field of ["artifactDigest", "byteLength"] as const) {
        const artifacts = selected.parent.artifacts.map((commitment, index) =>
          index === selectedIndex
            ? {
                ...commitment,
                [field]: field === "artifactDigest" ? wrongDigest : commitment.byteLength + 1,
              }
            : commitment,
        );
        await expect(
          verifyCanonicalWorkspaceEvidenceBundle({
            ...selected.input,
            workspaceParentBytes: encodeNativeWorkspaceBindingInput({
              ...selected.parent,
              artifacts,
            }),
          }),
        ).rejects.toThrow(
          new RegExp(`workspaceParent\\.artifacts\\[${selectedIndex}\\]\\.${field}`),
        );
      }
    }
    expect(() =>
      encodeNativeWorkspaceBindingInput({
        ...selected.parent,
        artifacts: [
          selected.parent.artifacts[1],
          selected.parent.artifacts[0],
          selected.parent.artifacts[2],
          selected.parent.artifacts[3],
        ],
      }),
    ).toThrow(/role must equal workspace\.canonical_directory/);
  });

  it("rejects runtime and incarnation transplants independently at every leaf", async () => {
    const selected = await fixture();
    const transplantedBundle = async (
      leafIndex: number,
      field: "runtimeId" | "nativeIncarnation",
      value: string | number,
    ): Promise<CanonicalWorkspaceEvidenceBundleInput> => {
      const mountNamespace = await canonicalLinuxMountNamespaceIdentityArtifact({
        ...selected.mountNamespace.evidence,
        ...(leafIndex === 0 ? { [field]: value } : {}),
      });
      const canonicalDirectory = await canonicalPosixCanonicalDirectoryEvidenceArtifact({
        ...selected.canonicalDirectory.evidence,
        mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
        ...(leafIndex === 1 ? { [field]: value } : {}),
      });
      const filesystemIdentity = await canonicalLinuxNoFollowFilesystemIdentityArtifact({
        ...selected.filesystemIdentity.evidence,
        mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
        canonicalDirectoryArtifactDigest: canonicalDirectory.commitment.artifactDigest,
        ...(leafIndex === 2 ? { [field]: value } : {}),
      });
      const allowedRoot = await canonicalLinuxAllowedRootAncestryArtifact({
        ...selected.allowedRoot.evidence,
        mountNamespaceArtifactDigest: mountNamespace.commitment.artifactDigest,
        canonicalDirectoryArtifactDigest: canonicalDirectory.commitment.artifactDigest,
        filesystemIdentityArtifactDigest: filesystemIdentity.commitment.artifactDigest,
        ...(leafIndex === 3 ? { [field]: value } : {}),
      });
      return {
        mountNamespaceBytes: mountNamespace.canonicalBytes.copyBytes(),
        canonicalDirectoryBytes: canonicalDirectory.canonicalBytes.copyBytes(),
        filesystemIdentityBytes: filesystemIdentity.canonicalBytes.copyBytes(),
        allowedRootBytes: allowedRoot.canonicalBytes.copyBytes(),
        workspaceParentBytes: encodeNativeWorkspaceBindingInput({
          ...selected.parent,
          artifacts: [
            canonicalDirectory.commitment,
            filesystemIdentity.commitment,
            allowedRoot.commitment,
            mountNamespace.commitment,
          ],
        }),
      };
    };
    for (const [field, value] of [
      ["runtimeId", OTHER_RUNTIME_ID],
      ["nativeIncarnation", 8],
    ] as const) {
      for (let leafIndex = 0; leafIndex < 4; leafIndex++) {
        await expect(
          verifyCanonicalWorkspaceEvidenceBundle(await transplantedBundle(leafIndex, field, value)),
        ).rejects.toThrow(new RegExp(`leaves\\[${leafIndex}\\]\\.${field}`));
      }
    }
  });

  it("snapshots all five bundle inputs and nested async DTOs before awaiting", async () => {
    const selected = await fixture();
    const originals = Object.fromEntries(
      Object.entries(selected.input).map(([key, bytes]) => [key, (bytes as Uint8Array).slice()]),
    ) as unknown as CanonicalWorkspaceEvidenceBundleInput;
    const pending = verifyCanonicalWorkspaceEvidenceBundle(selected.input);
    for (const bytes of Object.values(selected.input)) bytes.fill(0);
    const bundle = await pending;
    expect(bundle.mountNamespace.canonicalBytes.copyBytes()).toEqual(originals.mountNamespaceBytes);
    expect(bundle.workspaceParent.canonicalBytes.copyBytes()).toEqual(
      originals.workspaceParentBytes,
    );
    const exposedCopy = bundle.allowedRoot.canonicalBytes.copyBytes();
    exposedCopy.fill(0);
    expect(bundle.allowedRoot.canonicalBytes.copyBytes()).toEqual(originals.allowedRootBytes);
    expect(Object.isFrozen(bundle.workspaceParent.input)).toBe(true);
    expect(Object.isFrozen(bundle.workspaceParent.input.artifacts)).toBe(true);
    expect(Object.isFrozen(bundle.allowedRoot.evidence.targetEntries)).toBe(true);
    expect(Object.isFrozen(bundle.allowedRoot.evidence.targetEntries[0])).toBe(true);

    const fresh = await fixture();
    const dto = {
      ...fresh.allowedRoot.evidence,
      allowedRootEntries: fresh.allowedRoot.evidence.allowedRootEntries.map((item) => ({
        ...item,
      })),
      targetEntries: fresh.allowedRoot.evidence.targetEntries.map((item) => ({ ...item })),
    };
    const encodedBefore = fresh.input.allowedRootBytes;
    const encoding = encodeLinuxAllowedRootAncestry(dto);
    dto.allowedRoot = "/changed";
    const mutableTarget = dto.targetEntries[2];
    if (mutableTarget === undefined) throw new Error("fixture target entry is missing");
    mutableTarget.directoryInode = parseU64Decimal("123");
    await expect(encoding).resolves.toEqual(encodedBefore);
  });

  it("snapshots Buffer, offset subviews, and growable SharedArrayBuffer views safely", async () => {
    const selected = await fixture();
    const mountBytes = selected.input.mountNamespaceBytes;
    const backing = new Uint8Array(mountBytes.byteLength + 10).fill(0xaa);
    backing.set(mountBytes, 5);
    const subview = new Uint8Array(backing.buffer, 5, mountBytes.byteLength);
    expect(decodeLinuxMountNamespaceIdentity(subview)).toEqual(selected.mountNamespace.evidence);
    expect(decodeLinuxMountNamespaceIdentity(Buffer.from(mountBytes))).toEqual(
      selected.mountNamespace.evidence,
    );

    const GrowableSharedArrayBuffer = SharedArrayBuffer as unknown as {
      new (
        byteLength: number,
        options: { maxByteLength: number },
      ): SharedArrayBuffer & { grow(byteLength: number): void };
    };
    const growable = new GrowableSharedArrayBuffer(mountBytes.byteLength, {
      maxByteLength: mountBytes.byteLength + 16,
    });
    const tracking = new Uint8Array(growable);
    tracking.set(mountBytes);
    const pending = verifyCanonicalWorkspaceEvidenceBundle({
      ...selected.input,
      mountNamespaceBytes: tracking,
    });
    growable.grow(mountBytes.byteLength + 16);
    new Uint8Array(growable, mountBytes.byteLength).fill(0xee);
    const bundle = await pending;
    expect(bundle.mountNamespace.canonicalBytes.copyBytes()).toEqual(mountBytes);
    expect(
      decodeLinuxMountNamespaceIdentity(
        new Uint8Array(growable, 0, selected.input.mountNamespaceBytes.byteLength),
      ),
    ).toEqual(selected.mountNamespace.evidence);
  });

  it("does not invoke hostile typed-array species while taking bounded snapshots", async () => {
    const selected = await fixture();
    let speciesCalls = 0;
    class HostileBytes extends Uint8Array {
      static get [Symbol.species](): Uint8ArrayConstructor {
        speciesCalls++;
        throw new Error("hostile species must not run");
      }
    }
    const hostile = new HostileBytes(selected.input.mountNamespaceBytes.byteLength);
    hostile.set(selected.input.mountNamespaceBytes);
    expect(decodeLinuxMountNamespaceIdentity(hostile)).toEqual(selected.mountNamespace.evidence);
    expect(speciesCalls).toBe(0);
  });

  it("rejects non-byte bundle fields, extra keys, and pre-hash oversize inputs", async () => {
    const selected = await fixture();
    await expect(
      verifyCanonicalWorkspaceEvidenceBundle({
        ...selected.input,
        mountNamespaceBytes: [] as unknown as Uint8Array,
      }),
    ).rejects.toThrow(/genuine Uint8Array/);
    await expect(
      verifyCanonicalWorkspaceEvidenceBundle({ ...selected.input, extra: true } as never),
    ).rejects.toThrow(/exactly the selected fields/);
    await expect(
      verifyCanonicalWorkspaceEvidenceBundle({
        ...selected.input,
        allowedRootBytes: new Uint8Array(MAX_LINUX_ALLOWED_ROOT_ANCESTRY_BYTES + 1),
      }),
    ).rejects.toThrow(/1\.\.1048576 canonical bytes/);
  });

  it("keeps schema IDs and bounds closed against E1a's registry", () => {
    expect(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["workspace.mount_namespace"]).toEqual({
      artifactSchemaId: LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
      maxByteLength: 65_536,
      scopeKind: "runtime",
    });
    expect(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["workspace.canonical_directory"]).toEqual({
      artifactSchemaId: POSIX_CANONICAL_DIRECTORY_EVIDENCE_SCHEMA_ID,
      maxByteLength: 16_384,
      scopeKind: "runtime",
    });
    expect(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["workspace.filesystem_identity"]).toEqual({
      artifactSchemaId: LINUX_NO_FOLLOW_FILESYSTEM_IDENTITY_SCHEMA_ID,
      maxByteLength: 65_536,
      scopeKind: "runtime",
    });
    expect(NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS["workspace.allowed_root"]).toEqual({
      artifactSchemaId: LINUX_ALLOWED_ROOT_ANCESTRY_SCHEMA_ID,
      maxByteLength: 1_048_576,
      scopeKind: "runtime",
    });
  });

  it("shares identical mount bytes under exactly the workspace and isolation mount roles", async () => {
    const selected = await fixture();
    const workspace = selected.mountNamespace.commitment;
    const isolation = parseNativeEvidenceArtifactCommitment(
      {
        role: "isolation.mount_namespace",
        artifactSchemaId: LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
        artifactDigest: workspace.artifactDigest,
        byteLength: workspace.byteLength,
      },
      "isolation.mount_namespace",
    );
    expect(isolation).toMatchObject({
      artifactSchemaId: workspace.artifactSchemaId,
      artifactDigest: workspace.artifactDigest,
      byteLength: workspace.byteLength,
    });
    expect(() =>
      parseNativeEvidenceArtifactCommitment(
        { ...isolation, role: "isolation.network_namespace" },
        "isolation.network_namespace",
      ),
    ).toThrow(/artifactSchemaId must equal/);
    expect(() =>
      parseNativeEvidenceArtifactCommitment(isolation, "workspace.mount_namespace"),
    ).toThrow(/role must equal workspace\.mount_namespace/);
    const roles = Object.keys(
      NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS,
    ) as NativeBindingAuthorityArtifactRole[];
    expect(
      roles.filter(
        (role) =>
          NATIVE_BINDING_AUTHORITY_ARTIFACT_SPECS[role].artifactSchemaId ===
          LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
      ),
    ).toEqual(["workspace.mount_namespace", "isolation.mount_namespace"]);
    for (const role of roles) {
      if (role === "workspace.mount_namespace" || role === "isolation.mount_namespace") continue;
      expect(() =>
        parseNativeEvidenceArtifactCommitment(
          {
            role,
            artifactSchemaId: LINUX_MOUNT_NAMESPACE_IDENTITY_SCHEMA_ID,
            artifactDigest: workspace.artifactDigest,
            byteLength: workspace.byteLength,
          },
          role,
        ),
      ).toThrow(/artifactSchemaId must equal/);
    }
  });

  it("makes every non-fixed leaf field digest-sensitive and rejects fixed-literal changes", async () => {
    const selected = await fixture();
    const wrongDigest = parseA1Digest(encoded(32, 91));

    const mountChanges = [
      { runtimeId: OTHER_RUNTIME_ID },
      { nativeIncarnation: 8 },
      { bootId: "11112233-4455-6677-8899-aabbccddeeff" },
      { namespaceDevice: "1" },
      { namespaceInode: "1" },
    ];
    for (const change of mountChanges) {
      const changed = await canonicalLinuxMountNamespaceIdentityArtifact({
        ...selected.mountNamespace.evidence,
        ...change,
      });
      expect(changed.commitment.artifactDigest).not.toBe(
        selected.mountNamespace.commitment.artifactDigest,
      );
    }

    const alternatePath = "/srv/other";
    const directoryChanges = [
      { runtimeId: OTHER_RUNTIME_ID },
      { nativeIncarnation: 8 },
      { mountNamespaceArtifactDigest: wrongDigest },
      {
        canonicalDirectory: alternatePath,
        canonicalDirectoryPathDigest: await canonicalDirectoryPathDigest(alternatePath),
      },
    ];
    for (const change of directoryChanges) {
      const changed = await canonicalPosixCanonicalDirectoryEvidenceArtifact({
        ...selected.canonicalDirectory.evidence,
        ...change,
      });
      expect(changed.commitment.artifactDigest).not.toBe(
        selected.canonicalDirectory.commitment.artifactDigest,
      );
    }

    const filesystemChanges = [
      { runtimeId: OTHER_RUNTIME_ID },
      { nativeIncarnation: 8 },
      { mountNamespaceArtifactDigest: wrongDigest },
      { canonicalDirectoryArtifactDigest: wrongDigest },
      { canonicalDirectoryPathDigest: wrongDigest },
      { directoryDevice: "1" },
      { directoryInode: "1" },
      { mountId: "1" },
      { filesystemMagic: "1" },
    ];
    for (const change of filesystemChanges) {
      const changed = await canonicalLinuxNoFollowFilesystemIdentityArtifact({
        ...selected.filesystemIdentity.evidence,
        ...change,
      });
      expect(changed.commitment.artifactDigest).not.toBe(
        selected.filesystemIdentity.commitment.artifactDigest,
      );
    }

    const ancestry = selected.allowedRoot.evidence;
    const targetPathChange = ancestry.targetEntries.map((item, index) =>
      index === 2 ? { ...item, component: "other" } : { ...item },
    );
    const ancestryChanges: Record<string, unknown>[] = [
      { runtimeId: OTHER_RUNTIME_ID },
      { nativeIncarnation: 8 },
      { mountNamespaceArtifactDigest: wrongDigest },
      { canonicalDirectoryArtifactDigest: wrongDigest },
      { filesystemIdentityArtifactDigest: wrongDigest },
      {
        allowedRoot: "/srv/workspace",
        allowedRootPathDigest: ancestry.canonicalDirectoryPathDigest,
        allowedRootEntryCount: 3,
        allowedRootEntries: ancestry.targetEntries.map((item) => ({ ...item })),
      },
      {
        canonicalDirectoryPathDigest: await canonicalDirectoryPathDigest(alternatePath),
        targetEntries: targetPathChange,
      },
      {
        canonicalDirectoryPathDigest: await canonicalDirectoryPathDigest("/srv/workspace/child"),
        targetEntryCount: 4,
        targetEntries: [
          ...ancestry.targetEntries.map((item) => ({ ...item })),
          entry(3, "child", "2", "101", "42"),
        ],
      },
    ];
    const tupleFields = [
      ["directoryDevice", "21"],
      ["directoryInode", "101"],
      ["mountId", "43"],
      ["filesystemMagic", "1"],
    ] as const;
    for (const position of [0, 1, 2] as const) {
      for (const [field, value] of tupleFields) {
        const allowedRootEntries = ancestry.allowedRootEntries.map((item) => ({
          ...item,
        })) as Record<string, unknown>[];
        const targetEntries = ancestry.targetEntries.map((item) => ({
          ...item,
        })) as Record<string, unknown>[];
        const targetEntry = targetEntries[position];
        if (targetEntry === undefined) throw new Error("fixture target entry is missing");
        targetEntry[field] = value;
        if (position < allowedRootEntries.length) {
          const allowedEntry = allowedRootEntries[position];
          if (allowedEntry === undefined) throw new Error("fixture allowed entry is missing");
          allowedEntry[field] = value;
        }
        if (field === "mountId" && position === 1) {
          const finalEntry = targetEntries[2];
          if (finalEntry === undefined) throw new Error("fixture final entry is missing");
          finalEntry.mountId = value;
        }
        if (field === "mountId" && position === 2) {
          const boundaryAllowed = allowedRootEntries[1];
          const boundaryTarget = targetEntries[1];
          if (boundaryAllowed === undefined || boundaryTarget === undefined) {
            throw new Error("fixture boundary entry is missing");
          }
          boundaryAllowed.mountId = value;
          boundaryTarget.mountId = value;
        }
        ancestryChanges.push({ allowedRootEntries, targetEntries });
      }
    }
    for (const change of ancestryChanges) {
      const changed = await canonicalLinuxAllowedRootAncestryArtifact({
        ...ancestry,
        ...change,
      });
      expect(changed.commitment.artifactDigest).not.toBe(
        selected.allowedRoot.commitment.artifactDigest,
      );
    }

    const fixedLiteralCases: readonly (() => unknown | Promise<unknown>)[] = [
      () =>
        parseLinuxMountNamespaceIdentity({
          ...selected.mountNamespace.evidence,
          schemaId: "remote-claw/wrong/v1",
        }),
      () =>
        parseLinuxMountNamespaceIdentity({ ...selected.mountNamespace.evidence, schemaVersion: 2 }),
      () =>
        parseLinuxMountNamespaceIdentity({
          ...selected.mountNamespace.evidence,
          namespaceKind: "net",
        }),
      () =>
        parsePosixCanonicalDirectoryEvidence({
          ...selected.canonicalDirectory.evidence,
          schemaId: "remote-claw/wrong/v1",
        }),
      () =>
        parsePosixCanonicalDirectoryEvidence({
          ...selected.canonicalDirectory.evidence,
          schemaVersion: 2,
        }),
      () =>
        parsePosixCanonicalDirectoryEvidence({
          ...selected.canonicalDirectory.evidence,
          directoryNormalizationSchemaId: "remote-claw/wrong/v1",
        }),
      () =>
        parseLinuxNoFollowFilesystemIdentity({
          ...selected.filesystemIdentity.evidence,
          schemaId: "remote-claw/wrong/v1",
        }),
      () =>
        parseLinuxNoFollowFilesystemIdentity({
          ...selected.filesystemIdentity.evidence,
          schemaVersion: 2,
        }),
      () =>
        parseLinuxNoFollowFilesystemIdentity({
          ...selected.filesystemIdentity.evidence,
          fileKind: "file",
        }),
      () => parseLinuxAllowedRootAncestry({ ...ancestry, schemaId: "remote-claw/wrong/v1" }),
      () => parseLinuxAllowedRootAncestry({ ...ancestry, schemaVersion: 2 }),
      () => parseLinuxAllowedRootAncestry({ ...ancestry, suffixMountPolicy: "cross_mounts" }),
    ];
    for (const selectedCase of fixedLiteralCases) {
      await expect(Promise.resolve().then(selectedCase)).rejects.toThrow();
    }
  });
});
