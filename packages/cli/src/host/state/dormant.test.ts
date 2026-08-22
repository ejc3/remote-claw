import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const STATE_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PACKAGE_JSON = fileURLToPath(new URL("../../../package.json", import.meta.url));
const PACKAGE_ROOT = dirname(PACKAGE_JSON);
const ACTIVE_STATE_IMPORT_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  [
    resolve(SOURCE_ROOT, "host/native/evidence.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "records"),
      resolve(STATE_ROOT, "validation"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/native/linux-executable-collector.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "native-binding-authority-executable-evidence"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/runtime-owner/key-custody.ts"),
    new Set([resolve(STATE_ROOT, "ids"), resolve(STATE_ROOT, "protected")]),
  ],
  [
    resolve(SOURCE_ROOT, "host/runtime-owner/port-registry.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "validation"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/runtime-owner/production.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "runtime-repository"),
      resolve(STATE_ROOT, "sqlite"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/runtime-owner/registration-service.ts"),
    new Set([
      resolve(STATE_ROOT, "digests"),
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "records"),
      resolve(STATE_ROOT, "runtime-repository"),
      resolve(STATE_ROOT, "sqlite"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/runtime-owner/protocol.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "validation"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/server-signer/service.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "server-signing"),
      resolve(STATE_ROOT, "server-signing-repository"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/server-signer/orchestrator.ts"),
    new Set([
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "server-signing"),
      resolve(STATE_ROOT, "server-signing-repository"),
      resolve(STATE_ROOT, "sqlite"),
    ]),
  ],
  [
    resolve(SOURCE_ROOT, "host/server-signer/command-result-orchestrator.ts"),
    new Set([
      resolve(STATE_ROOT, "command-adjudication-repository"),
      resolve(STATE_ROOT, "ids"),
      resolve(STATE_ROOT, "protected"),
      resolve(STATE_ROOT, "records"),
      resolve(STATE_ROOT, "server-signing"),
      resolve(STATE_ROOT, "sqlite"),
    ]),
  ],
]);

const DORMANT_PRODUCTION_MODULES = new Set([
  resolve(SOURCE_ROOT, "host/native/linux-executable-collector"),
  resolve(SOURCE_ROOT, "host/server-signer/orchestrator"),
  resolve(SOURCE_ROOT, "host/server-signer/command-result-orchestrator"),
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

function packageExportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(packageExportTargets);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(packageExportTargets);
  }
  return [];
}

describe("A1 host-state boundary", () => {
  it("has an exact direct-import surface for active runtime-owner modules", async () => {
    const activeFiles = (await sourceFiles(SOURCE_ROOT)).filter(
      (path) => !path.startsWith(`${STATE_ROOT}/`) && !/\.test\.[cm]?[jt]sx?$/.test(path),
    );
    const importSpecifier =
      /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
    const brokerA1Protocol = ["remote-claw", "broker-a1"].join("-");

    for (const path of activeFiles) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain(brokerA1Protocol);
      for (const match of source.matchAll(importSpecifier)) {
        const specifier = match[1];
        if (specifier?.startsWith(".")) {
          const resolvedImport = resolve(dirname(path), specifier.replace(/\.[cm]?[jt]sx?$/, ""));
          const importsState =
            resolvedImport === STATE_ROOT || resolvedImport.startsWith(`${STATE_ROOT}/`);
          if (importsState) {
            expect(
              ACTIVE_STATE_IMPORT_ALLOWLIST.get(path)?.has(resolvedImport) ?? false,
              `${path}: ${specifier}`,
            ).toBe(true);
          }
        }
      }
    }

    const packageJson = JSON.parse(await readFile(PACKAGE_JSON, "utf8")) as {
      exports?: unknown;
    };
    for (const target of packageExportTargets(packageJson.exports)) {
      if (!target.startsWith(".")) continue;
      const resolvedTarget = resolve(PACKAGE_ROOT, target.replace(/\.[cm]?[jt]sx?$/, ""));
      expect(
        resolvedTarget === STATE_ROOT || resolvedTarget.startsWith(`${STATE_ROOT}/`),
        `package export: ${target}`,
      ).toBe(false);
    }
  });

  it("keeps dormant modules outside every production import graph", async () => {
    const sourcePaths = (await sourceFiles(SOURCE_ROOT)).filter(
      (path) => !/\.test\.[cm]?[jt]sx?$/.test(path),
    );
    const importSpecifier =
      /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
    const imports = new Map<string, ReadonlySet<string>>();
    for (const path of sourcePaths) {
      const source = await readFile(path, "utf8");
      const dependencies = new Set<string>();
      for (const match of source.matchAll(importSpecifier)) {
        const specifier = match[1];
        if (specifier?.startsWith(".")) {
          dependencies.add(resolve(dirname(path), specifier.replace(/\.[cm]?[jt]sx?$/, "")));
        }
      }
      imports.set(path.replace(/\.[cm]?[jt]sx?$/, ""), dependencies);
    }
    const productionRoots = [
      resolve(SOURCE_ROOT, "cli"),
      resolve(SOURCE_ROOT, "run"),
      resolve(SOURCE_ROOT, "runtime-owner-cli"),
      resolve(SOURCE_ROOT, "index"),
      resolve(SOURCE_ROOT, "broker/index"),
      resolve(SOURCE_ROOT, "host/rc/index"),
    ];
    const visited = new Set<string>();
    const pending = [...productionRoots];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      for (const dependency of imports.get(current) ?? []) pending.push(dependency);
    }
    for (const dormant of DORMANT_PRODUCTION_MODULES) {
      expect(visited, dormant).not.toContain(dormant);
    }
  });
});
