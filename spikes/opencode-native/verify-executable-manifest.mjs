#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_EVIDENCE_SHA256 =
	"2d72aed48760e320317b94009d90ea290b094f9f6b26796074c421f3e5749901";
const EXPECTED_PROBE_SHA256 =
	"e9ad440c6ca3e6c1e16bfc8a3225a0a7a0a89540f6a613cb0f31f94fe2febc91";
const EXPECTED_LAUNCHER_SHA256 =
	"d167e30e12cca32cc4a5da0003ee0deb1120b5ca5ee2d64cef23aec44a3c9fa9";
const EXPECTED_RAW_FILE_SHA256 = "_hg5rFxBfF_EoI3SaEZZB8PoxsoV5__ZPzqNxG1j0zk";
const PROOF_SCHEMA_ID =
	"remote-claw/retained-opencode-executable-manifest-proof/v1";
const MANIFEST_SCHEMA_ID = "remote-claw/native-executable-chunk-manifest/v1";
const CHUNKING_SCHEMA_ID = "remote-claw/fixed-executable-chunking/v1";
const CHUNK_DIGEST_DOMAIN = "remote-claw/executable-chunk/v1";
const CHUNK_VECTOR_DOMAIN = "remote-claw/executable-chunk-vector/v1";
const DIGEST_ALGORITHM = "SHA-256";
const CHUNK_BYTE_LENGTH = 1_048_576;
const MAX_FILE_BYTE_LENGTH = 268_435_456;
const MAX_CHUNK_COUNT = 256;
const MAX_MANIFEST_BYTE_LENGTH = 65_536;
const FILE_BYTE_LENGTH = 156_412_048;
const CHUNK_COUNT = 150;
const FINAL_CHUNK_BYTE_LENGTH = 174_224;
const packageDirectory = dirname(fileURLToPath(import.meta.url));

class IndependentCanonicalWriter {
	#parts = [];

	bytes(value) {
		const bytes = Buffer.from(value);
		assert.ok(bytes.byteLength <= 0xffff_ffff);
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32BE(bytes.byteLength);
		this.#parts.push(prefix, bytes);
	}

	str(value) {
		assert.equal(typeof value, "string");
		this.bytes(Buffer.from(value, "utf8"));
	}

	uint(value) {
		assert.equal(
			Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
			true,
		);
		const encoded = Buffer.alloc(8);
		encoded.writeBigUInt64BE(BigInt(value));
		this.bytes(encoded);
	}

	finish() {
		return Buffer.concat(this.#parts);
	}
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256Base64url(value) {
	return createHash("sha256").update(value).digest("base64url");
}

function strictA1Digest(value, field) {
	assert.equal(typeof value, "string", `${field} must be a string`);
	assert.match(
		value,
		/^[A-Za-z0-9_-]{43}$/,
		`${field} must be unpadded base64url SHA-256`,
	);
	const decoded = Buffer.from(value, "base64url");
	assert.equal(decoded.byteLength, 32, `${field} must decode to 32 bytes`);
	assert.equal(
		decoded.toString("base64url"),
		value,
		`${field} must be canonical base64url`,
	);
	return decoded;
}

function writeVector(writer, manifest) {
	writer.str(CHUNK_VECTOR_DOMAIN);
	writer.str(MANIFEST_SCHEMA_ID);
	writer.uint(1);
	writer.str(CHUNKING_SCHEMA_ID);
	writer.str(DIGEST_ALGORITHM);
	writer.uint(CHUNK_BYTE_LENGTH);
	writer.uint(FILE_BYTE_LENGTH);
	writer.uint(CHUNK_COUNT);
	for (const chunk of manifest.chunks) {
		writer.uint(chunk.chunkIndex);
		writer.uint(chunk.byteOffset);
		writer.uint(chunk.byteLength);
		writer.bytes(
			strictA1Digest(
				chunk.chunkDigest,
				`manifest.chunks[${chunk.chunkIndex}].chunkDigest`,
			),
		);
	}
}

function rebuildVectorPreimage(manifest) {
	const writer = new IndependentCanonicalWriter();
	writeVector(writer, manifest);
	return writer.finish();
}

function rebuildCanonicalManifest(manifest) {
	const writer = new IndependentCanonicalWriter();
	writer.str(MANIFEST_SCHEMA_ID);
	writer.uint(1);
	writer.str(CHUNKING_SCHEMA_ID);
	writer.str(DIGEST_ALGORITHM);
	writer.uint(CHUNK_BYTE_LENGTH);
	writer.uint(FILE_BYTE_LENGTH);
	writer.bytes(
		strictA1Digest(manifest.rawFileSha256, "manifest.rawFileSha256"),
	);
	writer.uint(CHUNK_COUNT);
	for (const chunk of manifest.chunks) {
		writer.uint(chunk.chunkIndex);
		writer.uint(chunk.byteOffset);
		writer.uint(chunk.byteLength);
		writer.bytes(
			strictA1Digest(
				chunk.chunkDigest,
				`manifest.chunks[${chunk.chunkIndex}].chunkDigest`,
			),
		);
	}
	writer.bytes(
		strictA1Digest(manifest.chunkVectorDigest, "manifest.chunkVectorDigest"),
	);
	return writer.finish();
}

const [evidenceBytes, probeBytes, existingEvidenceBytes] = await Promise.all([
	readFile(join(packageDirectory, "executable-manifest-evidence-1.17.5.json")),
	readFile(join(packageDirectory, "executable-manifest-probe.mjs")),
	readFile(join(packageDirectory, "evidence-1.17.5.json")),
]);
const evidenceText = evidenceBytes.toString("utf8");
const probeText = probeBytes.toString("utf8");
assert.equal(
	sha256(evidenceBytes),
	EXPECTED_EVIDENCE_SHA256,
	"retained evidence bytes changed",
);
assert.equal(
	sha256(probeBytes),
	EXPECTED_PROBE_SHA256,
	"retained probe bytes changed",
);
assert.doesNotMatch(evidenceText, /\/(?:home|Users)\//);
assert.doesNotMatch(evidenceText, /(?:\/)?tmp\/remote-claw-/);
assert.doesNotMatch(probeText, /node:(?:child_process|http|https|net|tls)/);
assert.doesNotMatch(probeText, /\b(?:fetch|spawn)\s*\(/);

const evidence = JSON.parse(evidenceText);
const existing = JSON.parse(existingEvidenceBytes.toString("utf8"));
assert.deepEqual(Object.keys(evidence), [
	"proofSchemaId",
	"proofSchemaVersion",
	"proofScope",
	"scopeLimits",
	"probe",
	"opencode",
	"collection",
	"manifest",
	"chunkVectorAudit",
	"canonicalManifestAudit",
]);
assert.equal(evidence.proofSchemaId, PROOF_SCHEMA_ID);
assert.equal(evidence.proofSchemaVersion, 1);
assert.match(evidence.proofScope, /two-pass.*OpenCode 1\.17\.5 Linux arm64/);
assert.deepEqual(evidence.scopeLimits, {
	binaryExecuted: false,
	serverStarted: false,
	providerCredentialsRead: false,
	networkAccessUsed: false,
	rawChunkBytesRetained: false,
});
assert.deepEqual(evidence.probe, {
	file: "executable-manifest-probe.mjs",
	sha256: EXPECTED_PROBE_SHA256,
});
assert.deepEqual(evidence.opencode, {
	version: existing.opencode.version,
	launcherPath: "<opencode-launcher>",
	launcherSha256: existing.opencode.launcherSha256,
	nativeBinaryPath: "<opencode-native-binary>",
	platform: existing.opencode.platform,
	architecture: existing.opencode.architecture,
});
assert.equal(existing.opencode.version, "1.17.5");
assert.equal(existing.opencode.launcherSha256, EXPECTED_LAUNCHER_SHA256);
assert.equal(
	Buffer.from(existing.opencode.nativeBinarySha256, "hex").toString(
		"base64url",
	),
	EXPECTED_RAW_FILE_SHA256,
);
assert.equal(existing.opencode.platform, "linux");
assert.equal(existing.opencode.architecture, "arm64");

assert.deepEqual(evidence.collection, {
	openFlags: "O_RDONLY|O_NOFOLLOW|O_NONBLOCK",
	sameOpenFileDescriptorForBothPasses: true,
	regularFile: true,
	executableMode: true,
	passCount: 2,
	preBetweenPostFstatStable: true,
	eofVerifiedEachPass: true,
	rawChunkBytesRetained: false,
	maxFileByteLength: MAX_FILE_BYTE_LENGTH,
	maxChunkCount: MAX_CHUNK_COUNT,
	maxManifestByteLength: MAX_MANIFEST_BYTE_LENGTH,
});

const manifest = evidence.manifest;
assert.deepEqual(Object.keys(manifest), [
	"schemaId",
	"schemaVersion",
	"chunkingSchemaId",
	"digestAlgorithm",
	"nominalChunkBytes",
	"fileByteLength",
	"rawFileSha256",
	"chunkCount",
	"chunks",
	"chunkVectorDigest",
]);
assert.equal(manifest.schemaId, MANIFEST_SCHEMA_ID);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.chunkingSchemaId, CHUNKING_SCHEMA_ID);
assert.equal(manifest.digestAlgorithm, DIGEST_ALGORITHM);
assert.equal(manifest.nominalChunkBytes, CHUNK_BYTE_LENGTH);
assert.equal(manifest.fileByteLength, FILE_BYTE_LENGTH);
assert.equal(manifest.rawFileSha256, EXPECTED_RAW_FILE_SHA256);
assert.equal(manifest.chunkCount, CHUNK_COUNT);
assert.equal(manifest.chunks.length, CHUNK_COUNT);
assert.equal(FILE_BYTE_LENGTH <= MAX_FILE_BYTE_LENGTH, true);
assert.equal(CHUNK_COUNT <= MAX_CHUNK_COUNT, true);

let expectedOffset = 0;
for (const [index, chunk] of manifest.chunks.entries()) {
	assert.deepEqual(Object.keys(chunk), [
		"chunkIndex",
		"byteOffset",
		"byteLength",
		"chunkDigest",
	]);
	assert.equal(chunk.chunkIndex, index);
	assert.equal(chunk.byteOffset, expectedOffset);
	const expectedLength = Math.min(
		CHUNK_BYTE_LENGTH,
		FILE_BYTE_LENGTH - expectedOffset,
	);
	assert.equal(chunk.byteLength, expectedLength);
	strictA1Digest(chunk.chunkDigest, `manifest.chunks[${index}].chunkDigest`);
	expectedOffset += expectedLength;
}
assert.equal(expectedOffset, FILE_BYTE_LENGTH);
assert.equal(manifest.chunks.at(-1).byteLength, FINAL_CHUNK_BYTE_LENGTH);

const vectorPreimage = rebuildVectorPreimage(manifest);
assert.deepEqual(evidence.chunkVectorAudit, {
	domain: CHUNK_VECTOR_DOMAIN,
	canonicalFieldOrder: [
		"domain",
		"manifestSchemaId",
		"schemaVersion",
		"chunkingSchemaId",
		"digestAlgorithm",
		"nominalChunkBytes",
		"fileByteLength",
		"chunkCount",
		"chunks[chunkIndex,byteOffset,byteLength,chunkDigest]",
	],
	preimageByteLength: vectorPreimage.byteLength,
	digest: sha256Base64url(vectorPreimage),
});
assert.equal(manifest.chunkVectorDigest, sha256Base64url(vectorPreimage));

const canonicalBytes = rebuildCanonicalManifest(manifest);
assert.equal(canonicalBytes.byteLength <= MAX_MANIFEST_BYTE_LENGTH, true);
assert.deepEqual(evidence.canonicalManifestAudit, {
	canonicalFieldOrder: [
		"schemaId",
		"schemaVersion",
		"chunkingSchemaId",
		"digestAlgorithm",
		"nominalChunkBytes",
		"fileByteLength",
		"rawFileSha256",
		"chunkCount",
		"chunks[chunkIndex,byteOffset,byteLength,chunkDigest]",
		"chunkVectorDigest",
	],
	byteLength: canonicalBytes.byteLength,
	bytesBase64url: canonicalBytes.toString("base64url"),
	sha256: sha256(canonicalBytes),
});

assert.equal(probeText.includes(CHUNK_DIGEST_DOMAIN), true);
assert.equal(
	(probeText.match(/await collectPass\(file, fileByteLength\)/g) ?? []).length,
	2,
);
assert.equal(probeText.includes("process.env.PATH"), true);
assert.doesNotMatch(
	probeText,
	/process\.env\.(?!PATH\b)[A-Za-z_][A-Za-z0-9_]*/,
);

console.log(
	`verified retained OpenCode 1.17.5 executable manifest: ${manifest.fileByteLength} bytes, ${manifest.chunkCount} domain-separated chunks, two stable descriptor passes`,
);
