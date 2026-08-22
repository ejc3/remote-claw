#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, open, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const PROOF_SCHEMA_ID =
	"remote-claw/retained-opencode-executable-manifest-proof/v1";
const MANIFEST_SCHEMA_ID = "remote-claw/native-executable-chunk-manifest/v1";
const CHUNKING_SCHEMA_ID = "remote-claw/fixed-executable-chunking/v1";
const CHUNK_DIGEST_DOMAIN = "remote-claw/executable-chunk/v1";
const CHUNK_VECTOR_DOMAIN = "remote-claw/executable-chunk-vector/v1";
const DIGEST_ALGORITHM = "SHA-256";
const SCHEMA_VERSION = 1;
const CHUNK_BYTE_LENGTH = 1_048_576;
const MAX_FILE_BYTE_LENGTH = 268_435_456;
const MAX_CHUNK_COUNT = 256;
const MAX_MANIFEST_BYTE_LENGTH = 65_536;
const EXPECTED_VERSION = "1.17.5";
const EXPECTED_FILE_BYTE_LENGTH = 156_412_048;
const EXPECTED_CHUNK_COUNT = 150;
const EXPECTED_FINAL_CHUNK_BYTE_LENGTH = 174_224;
const EXPECTED_LAUNCHER_SHA256 =
	"d167e30e12cca32cc4a5da0003ee0deb1120b5ca5ee2d64cef23aec44a3c9fa9";
const EXPECTED_RAW_FILE_SHA256 = "_hg5rFxBfF_EoI3SaEZZB8PoxsoV5__ZPzqNxG1j0zk";
const scriptPath = fileURLToPath(import.meta.url);

class CanonicalAuditWriter {
	#parts = [];

	bytes(value) {
		const bytes = Buffer.from(value);
		assert(
			bytes.byteLength <= 0xffff_ffff,
			"canonical byte field is too large",
		);
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32BE(bytes.byteLength);
		this.#parts.push(prefix, bytes);
	}

	str(value) {
		assert(typeof value === "string", "canonical string must be a string");
		this.bytes(Buffer.from(value, "utf8"));
	}

	uint(value) {
		assert(
			Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
			"canonical uint must be a non-negative safe integer",
		);
		const encoded = Buffer.alloc(8);
		encoded.writeBigUInt64BE(BigInt(value));
		this.bytes(encoded);
	}

	finish() {
		return Buffer.concat(this.#parts);
	}
}

class CanonicalAuditHasher {
	#hash = createHash("sha256");

	bytes(value) {
		const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		assert(
			bytes.byteLength <= 0xffff_ffff,
			"canonical byte field is too large",
		);
		const prefix = Buffer.alloc(4);
		prefix.writeUInt32BE(bytes.byteLength);
		this.#hash.update(prefix);
		this.#hash.update(bytes);
	}

	str(value) {
		assert(typeof value === "string", "canonical string must be a string");
		this.bytes(Buffer.from(value, "utf8"));
	}

	uint(value) {
		assert(
			Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
			"canonical uint must be a non-negative safe integer",
		);
		const encoded = Buffer.alloc(8);
		encoded.writeBigUInt64BE(BigInt(value));
		this.bytes(encoded);
	}

	digest() {
		return this.#hash.digest();
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function base64urlDigest(value) {
	return Buffer.from(value).toString("base64url");
}

function writeChunkVectorFields(writer, fileByteLength, chunks) {
	writer.str(CHUNK_VECTOR_DOMAIN);
	writer.str(MANIFEST_SCHEMA_ID);
	writer.uint(SCHEMA_VERSION);
	writer.str(CHUNKING_SCHEMA_ID);
	writer.str(DIGEST_ALGORITHM);
	writer.uint(CHUNK_BYTE_LENGTH);
	writer.uint(fileByteLength);
	writer.uint(chunks.length);
	for (const chunk of chunks) {
		writer.uint(chunk.chunkIndex);
		writer.uint(chunk.byteOffset);
		writer.uint(chunk.byteLength);
		writer.bytes(Buffer.from(chunk.chunkDigest, "base64url"));
	}
}

function chunkDigest(fileByteLength, chunkIndex, byteOffset, exactBytes) {
	const writer = new CanonicalAuditHasher();
	writer.str(CHUNK_DIGEST_DOMAIN);
	writer.str(MANIFEST_SCHEMA_ID);
	writer.uint(SCHEMA_VERSION);
	writer.uint(fileByteLength);
	writer.uint(CHUNK_BYTE_LENGTH);
	writer.uint(chunkIndex);
	writer.uint(byteOffset);
	writer.bytes(exactBytes);
	return writer.digest();
}

function chunkVectorPreimage(fileByteLength, chunks) {
	const writer = new CanonicalAuditWriter();
	writeChunkVectorFields(writer, fileByteLength, chunks);
	return writer.finish();
}

function canonicalManifest(manifest) {
	const writer = new CanonicalAuditWriter();
	writer.str(manifest.schemaId);
	writer.uint(manifest.schemaVersion);
	writer.str(manifest.chunkingSchemaId);
	writer.str(manifest.digestAlgorithm);
	writer.uint(manifest.nominalChunkBytes);
	writer.uint(manifest.fileByteLength);
	writer.bytes(Buffer.from(manifest.rawFileSha256, "base64url"));
	writer.uint(manifest.chunkCount);
	for (const chunk of manifest.chunks) {
		writer.uint(chunk.chunkIndex);
		writer.uint(chunk.byteOffset);
		writer.uint(chunk.byteLength);
		writer.bytes(Buffer.from(chunk.chunkDigest, "base64url"));
	}
	writer.bytes(Buffer.from(manifest.chunkVectorDigest, "base64url"));
	return writer.finish();
}

function stableStatIdentity(stat) {
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		nlink: stat.nlink,
		uid: stat.uid,
		gid: stat.gid,
		rdev: stat.rdev,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
}

async function readExact(file, buffer, byteLength, byteOffset) {
	let filled = 0;
	while (filled < byteLength) {
		const { bytesRead } = await file.read(
			buffer,
			filled,
			byteLength - filled,
			byteOffset + filled,
		);
		assert(
			bytesRead > 0,
			`executable truncated at byte ${byteOffset + filled}`,
		);
		filled += bytesRead;
	}
}

async function collectPass(file, fileByteLength) {
	const rawHash = createHash("sha256");
	const chunks = [];
	const buffer = Buffer.alloc(CHUNK_BYTE_LENGTH);
	let byteOffset = 0;
	let chunkIndex = 0;
	while (byteOffset < fileByteLength) {
		const byteLength = Math.min(CHUNK_BYTE_LENGTH, fileByteLength - byteOffset);
		await readExact(file, buffer, byteLength, byteOffset);
		const exactBytes = buffer.subarray(0, byteLength);
		rawHash.update(exactBytes);
		chunks.push({
			chunkIndex,
			byteOffset,
			byteLength,
			chunkDigest: base64urlDigest(
				chunkDigest(fileByteLength, chunkIndex, byteOffset, exactBytes),
			),
		});
		byteOffset += byteLength;
		chunkIndex += 1;
	}
	const eof = Buffer.alloc(1);
	const { bytesRead: eofBytesRead } = await file.read(
		eof,
		0,
		eof.byteLength,
		fileByteLength,
	);
	assert(eofBytesRead === 0, "executable grew beyond its measured byte length");
	return {
		rawFileSha256: rawHash.digest("base64url"),
		chunks,
		eofVerified: true,
	};
}

async function collectExecutableManifest(binaryPath) {
	assert(process.platform === "linux", "this retained proof requires Linux");
	assert(
		typeof fsConstants.O_NOFOLLOW === "number" &&
			typeof fsConstants.O_NONBLOCK === "number",
		"this retained proof requires O_NOFOLLOW and O_NONBLOCK",
	);
	const openFlags =
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
	const file = await open(binaryPath, openFlags);
	try {
		const before = await file.stat({ bigint: true });
		assert(before.isFile(), "OpenCode executable is not a regular file");
		assert((before.mode & 0o111n) !== 0n, "OpenCode binary is not executable");
		assert(before.size > 0n, "OpenCode executable is empty");
		assert(
			before.size <= BigInt(MAX_FILE_BYTE_LENGTH),
			`OpenCode executable exceeds ${MAX_FILE_BYTE_LENGTH} bytes`,
		);
		const fileByteLength = Number(before.size);
		assert(
			Number.isSafeInteger(fileByteLength),
			"OpenCode executable length is not a safe integer",
		);

		const firstPass = await collectPass(file, fileByteLength);
		const between = await file.stat({ bigint: true });
		assert(
			isDeepStrictEqual(
				stableStatIdentity(before),
				stableStatIdentity(between),
			),
			"OpenCode executable identity changed during the first pass",
		);
		const secondPass = await collectPass(file, fileByteLength);
		const after = await file.stat({ bigint: true });
		assert(
			isDeepStrictEqual(stableStatIdentity(before), stableStatIdentity(after)),
			"OpenCode executable identity changed during collection",
		);
		assert(
			isDeepStrictEqual(firstPass, secondPass),
			"two passes over the same OpenCode executable descriptor disagreed",
		);
		assert(
			firstPass.chunks.length <= MAX_CHUNK_COUNT,
			"chunk count exceeds protocol bound",
		);

		const vectorPreimage = chunkVectorPreimage(
			fileByteLength,
			firstPass.chunks,
		);
		const vectorDigest = createHash("sha256")
			.update(vectorPreimage)
			.digest("base64url");
		const manifest = {
			schemaId: MANIFEST_SCHEMA_ID,
			schemaVersion: SCHEMA_VERSION,
			chunkingSchemaId: CHUNKING_SCHEMA_ID,
			digestAlgorithm: DIGEST_ALGORITHM,
			nominalChunkBytes: CHUNK_BYTE_LENGTH,
			fileByteLength,
			rawFileSha256: firstPass.rawFileSha256,
			chunkCount: firstPass.chunks.length,
			chunks: firstPass.chunks,
			chunkVectorDigest: vectorDigest,
		};
		const manifestBytes = canonicalManifest(manifest);
		assert(
			manifestBytes.byteLength <= MAX_MANIFEST_BYTE_LENGTH,
			`canonical manifest exceeds ${MAX_MANIFEST_BYTE_LENGTH} bytes`,
		);
		return {
			manifest,
			vectorPreimage,
			manifestBytes,
			collection: {
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
			},
		};
	} finally {
		await file.close();
	}
}

async function sha256File(pathname) {
	const hash = createHash("sha256");
	await new Promise((resolve, reject) => {
		const stream = createReadStream(pathname);
		stream.once("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("end", resolve);
	});
	return hash.digest("hex");
}

async function resolveExecutable(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return realpath(candidate);
		} catch {
			// Continue through PATH without invoking a shell or inheriting its aliases.
		}
	}
	throw new Error(`${name} was not found on PATH`);
}

async function resolveNativeBinary(launcher) {
	const launcherText = await readFile(launcher, "utf8");
	const match = launcherText.match(
		/"\$basedir\/([^"\n]*opencode-ai@1\.17\.5\/node_modules\/opencode-ai\/bin\/opencode\.exe)"/,
	);
	assert(match?.[1], "could not resolve pinned OpenCode 1.17.5 native binary");
	const binary = join(dirname(launcher), match[1]);
	await access(binary, fsConstants.X_OK);
	return realpath(binary);
}

const launcher = await resolveExecutable("opencode");
const binary = await resolveNativeBinary(launcher);
const [launcherSha256, probeSha256, collected] = await Promise.all([
	sha256File(launcher),
	sha256File(scriptPath),
	collectExecutableManifest(binary),
]);

assert(
	launcherSha256 === EXPECTED_LAUNCHER_SHA256,
	`OpenCode launcher hash changed: ${launcherSha256}`,
);
assert(
	collected.manifest.fileByteLength === EXPECTED_FILE_BYTE_LENGTH,
	`OpenCode executable length changed: ${collected.manifest.fileByteLength}`,
);
assert(
	collected.manifest.rawFileSha256 === EXPECTED_RAW_FILE_SHA256,
	`OpenCode executable hash changed: ${collected.manifest.rawFileSha256}`,
);
assert(
	collected.manifest.chunkCount === EXPECTED_CHUNK_COUNT,
	`OpenCode executable chunk count changed: ${collected.manifest.chunkCount}`,
);
assert(
	collected.manifest.chunks.at(-1)?.byteLength ===
		EXPECTED_FINAL_CHUNK_BYTE_LENGTH,
	"OpenCode executable final chunk length changed",
);

const evidence = {
	proofSchemaId: PROOF_SCHEMA_ID,
	proofSchemaVersion: SCHEMA_VERSION,
	proofScope:
		"two-pass, descriptor-stable canonical executable manifest for the pinned real OpenCode 1.17.5 Linux arm64 native binary",
	scopeLimits: {
		binaryExecuted: false,
		serverStarted: false,
		providerCredentialsRead: false,
		networkAccessUsed: false,
		rawChunkBytesRetained: false,
	},
	probe: {
		file: "executable-manifest-probe.mjs",
		sha256: probeSha256,
	},
	opencode: {
		version: EXPECTED_VERSION,
		launcherPath: "<opencode-launcher>",
		launcherSha256,
		nativeBinaryPath: "<opencode-native-binary>",
		platform: process.platform,
		architecture: process.arch,
	},
	collection: collected.collection,
	manifest: collected.manifest,
	chunkVectorAudit: {
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
		preimageByteLength: collected.vectorPreimage.byteLength,
		digest: collected.manifest.chunkVectorDigest,
	},
	canonicalManifestAudit: {
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
		byteLength: collected.manifestBytes.byteLength,
		bytesBase64url: collected.manifestBytes.toString("base64url"),
		sha256: createHash("sha256").update(collected.manifestBytes).digest("hex"),
	},
};

process.stdout.write(`${JSON.stringify(evidence, null, "\t")}\n`);
