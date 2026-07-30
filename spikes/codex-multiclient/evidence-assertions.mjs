import assert from "node:assert/strict";

export const EXPECTED_CODEX_BINARY_SHA256 =
	"cb5e8cb8a333a408ce6adbe0d4fad1845c69772c2216af7c1f88c98a11460dc6";

export const EXPECTED_ISOLATED_ENVIRONMENT_NAMES = [
	"ALL_PROXY",
	"CODEX_HOME",
	"HOME",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOGNAME",
	"NO_PROXY",
	"PATH",
	"RUST_LOG",
	"TERM",
	"USER",
	"ZDOTDIR",
	"all_proxy",
	"http_proxy",
	"https_proxy",
	"no_proxy",
];

export const FORBIDDEN_CREDENTIAL_ENVIRONMENT_NAMES = [
	"OPENAI_API_KEY",
	"CHATGPT_ACCESS_TOKEN",
	"CODEX_API_KEY",
];

export const NAMESPACE_ID_PATTERN = /^net:\[\d+\]$/;

export const SELECTED_PROJECTION_METHODS = [
	"turn/started",
	"item/started",
	"item/commandExecution/outputDelta",
	"item/completed",
	"turn/completed",
];

export const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertCapturedAt(capturedAt) {
	assert.equal(typeof capturedAt, "string");
	assert.ok(Number.isFinite(Date.parse(capturedAt)));
}

export function assertNoCredentialEnvironmentNames(environmentNames) {
	for (const forbiddenName of FORBIDDEN_CREDENTIAL_ENVIRONMENT_NAMES) {
		assert.ok(!environmentNames.includes(forbiddenName));
	}
}

export function assertNoHostPaths(...texts) {
	const forbiddenPatterns = [
		/\/home\//,
		/\/tmp\//,
		/\/Users\//,
		/[A-Za-z]:\/Users\//,
		/[A-Za-z]:\\\\Users\\\\/,
	];
	for (const text of texts) {
		for (const pattern of forbiddenPatterns) {
			assert.doesNotMatch(
				text,
				pattern,
				`retained evidence contains a host path: ${pattern}`,
			);
		}
	}
}

export function assertUniqueIdentifiers(identifiers) {
	for (const identifier of identifiers) {
		assert.match(identifier, UUID_PATTERN);
	}
	assert.equal(
		new Set(identifiers).size,
		identifiers.length,
		"native identifiers must be pairwise distinct",
	);
}

export function outputRecord(utf8) {
	return {
		base64: Buffer.from(utf8).toString("base64"),
		byteLength: Buffer.byteLength(utf8),
		utf8,
	};
}
