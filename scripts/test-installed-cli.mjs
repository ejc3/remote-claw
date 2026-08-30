import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "remote-claw-install-smoke-"));

try {
	execFileSync(
		process.execPath,
		[join(repositoryRoot, "scripts/build-cli.mjs")],
		{
			cwd: repositoryRoot,
			stdio: "inherit",
		},
	);
	const packed = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
			{ cwd: repositoryRoot, encoding: "utf8" },
		),
	);
	const filename = packed[0]?.filename;
	if (typeof filename !== "string" || filename === "")
		throw new Error("npm pack returned no file");
	const tarball = join(scratch, filename);
	const installRoot = join(scratch, "consumer");
	execFileSync(
		"npm",
		[
			"install",
			"--prefix",
			installRoot,
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			tarball,
		],
		{ cwd: scratch, stdio: "inherit" },
	);

	const executable = join(installRoot, "node_modules", ".bin", "remote-claw");
	const invalid = spawnSync(executable, ["--rc-bogus"], {
		cwd: scratch,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	});
	if (
		invalid.status !== 2 ||
		invalid.stdout !== "" ||
		invalid.stderr !== "remote-claw: unknown flag --rc-bogus\n"
	) {
		throw new Error(
			`installed invalid-argument boundary mismatch: ${JSON.stringify({
				status: invalid.status,
				signal: invalid.signal,
				stdout: invalid.stdout,
				stderr: invalid.stderr,
			})}`,
		);
	}

	const help = spawnSync(executable, ["--rc-trace", "--help"], {
		cwd: scratch,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	});
	if (
		help.status !== 0 ||
		!help.stdout.includes("remote-claw") ||
		help.stderr !== ""
	) {
		throw new Error(
			`installed help boundary mismatch: ${JSON.stringify({
				status: help.status,
				signal: help.signal,
				stdout: help.stdout.slice(0, 200),
				stderr: help.stderr,
			})}`,
		);
	}

	// Exercise the packed artifact's Claude-native ATTACH dispatch at a boundary that must reject
	// before identity creation, credential access, compatibility probing, broker I/O, proxy setup, or
	// spawning Claude. This catches a bundle that advertises the flag in source/help but omits its parser
	// or dispatch wiring, without turning the install smoke into a credentialed/networked integration test.
	const nativeSecret = join(scratch, "native-attach-secret");
	const nativeCerts = join(scratch, "mitm-certs");
	const nativeAttach = spawnSync(
		executable,
		[
			"--rc-app=https://broker.invalid",
			"--rc-driver=claude-native",
			"--rc-native-session=not-a-canonical-session",
		],
		{
			cwd: scratch,
			encoding: "utf8",
			timeout: 5_000,
			env: {
				PATH: process.env.PATH ?? "",
				CLAUDE_CONFIG_DIR: join(scratch, "empty-claude-config"),
				RC_CLAUDE_BIN: join(scratch, "must-not-spawn-claude"),
				REMOTE_CLAW_SECRET_FILE: nativeSecret,
			},
		},
	);
	if (
		nativeAttach.status !== 2 ||
		nativeAttach.stdout !== "" ||
		nativeAttach.stderr !==
			"remote-claw: --rc-native-session must be a canonical cse_* session id\n" ||
		existsSync(nativeSecret) ||
		existsSync(nativeCerts)
	) {
		throw new Error(
			`installed Claude-native attach boundary mismatch: ${JSON.stringify({
				status: nativeAttach.status,
				signal: nativeAttach.signal,
				stdout: nativeAttach.stdout,
				stderr: nativeAttach.stderr,
				identityCreated: existsSync(nativeSecret),
				proxyMaterialCreated: existsSync(nativeCerts),
			})}`,
		);
	}

	const bundle = readFileSync(
		join(repositoryRoot, "dist", "remote-claw.js"),
		"utf8",
	);
	if (!bundle.startsWith("#!/usr/bin/env node"))
		throw new Error("installed CLI bundle lost shebang");
	if (bundle.includes(repositoryRoot))
		throw new Error("installed CLI bundle embeds repository path");
	process.stdout.write("installed remote-claw artifact: green\n");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
