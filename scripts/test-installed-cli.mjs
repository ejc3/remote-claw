import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
