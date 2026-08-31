import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(repositoryRoot, "dist");
const outputFile = join(outputDirectory, "remote-claw.js");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
	entryPoints: {
		"remote-claw": join(repositoryRoot, "packages/cli/src/cli.ts"),
	},
	outdir: outputDirectory,
	bundle: true,
	splitting: true,
	chunkNames: "chunks/[name]-[hash]",
	platform: "node",
	format: "esm",
	target: "node22.13",
	packages: "bundle",
	// Some bundled CommonJS dependencies (notably ws) retain dynamic requires for Node built-ins.
	// Give esbuild's ESM require shim the native loader while keeping the published CLI self-contained.
	banner: {
		js: 'import { createRequire as __remoteClawCreateRequire } from "node:module"; const require = __remoteClawCreateRequire(import.meta.url);',
	},
	legalComments: "none",
	sourcemap: false,
	minify: false,
	logLevel: "info",
});
await chmod(outputFile, 0o755);
