// RELEASE-GATE TOPOLOGY/BROWSER LEG — one causal topology, with no source-import substitution:
// real Chromium ⇄ deployed durable SQLite/Turso broker ⇄ packed+installed remote-claw ⇄ real Claude PTY.
// This is intentionally explicit/manual: it consumes two real Claude inference turns and requires the
// Vercel preview's automation bypass. Its receipt remains inspectionStatus=pending until a separate
// bounded Turso/Vercel run-sentinel inspection. No credential, prompt response, bearer, or trace body is printed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Request as PlaywrightRequest, test } from "@playwright/test";
// @ts-expect-error The trusted release runner is deliberately plain Node ESM, outside this TS project.
import * as trustedTopologyRunner from "../../../scripts/run-trusted-real-topology.mjs";
import { primeVercelBypass } from "./protection-bypass";

const {
  attestReleaseCleanProcessEnvironment,
  matchesReleaseClaudeProcessArguments,
  preparePrivateReceiptDirectory,
  writeDurableReceiptFile,
} = trustedTopologyRunner;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const CLAUDE_BIN = "/usr/bin/claude";
const NODE_BIN = "/usr/bin/node";
const NPM_BIN = "/usr/bin/npm";
const SCRIPT_BIN = "/usr/bin/script";
const TRUSTED_PATH = "/usr/bin:/bin";
const CLAUDE_CWD = process.env.RC_PROVE_CLAUDE_CWD;
const RECEIPT_SCHEMA = "remote-claw-real-topology-browser-leg/v4";
const PINNED_CLAUDE_VERSION = "2.1.237 (Claude Code)";
const PINNED_CLAUDE_PLATFORM = "linux";
const PINNED_CLAUDE_ARCH = "arm64";
const PINNED_CLAUDE_EXECUTABLE_SHA256 =
  "a701cfb6bb4703abc6f3ce47508c878ca8158ebdbeacd5c35c7d510c7bc70177";
const PINNED_CLAUDE_BINARY_BYTES = 331_864_296;
const VERCEL_PROJECT_ID = "prj_qUeYYc7P87JmsQUipJG0m0kqmYbM";
const VERCEL_TEAM_ID = "team_fYexi4KRmIrq9wtYsiXs9e9H";
const WAF_RULE_NAME = "handoff-per-ip-rate-limit";
const PLANNED_STREAM_ROTATION_MS = 240_000;
const ROTATION_PROOF_TIMEOUT_MS = 285_000;
const RELEASE_CLAUDE_ARGUMENTS = [
  "--safe-mode",
  "--tools",
  "",
  "--remote-control",
  "remote-claw-release-proof",
] as const;

function requiredProofEnv(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`trusted real-topology runner did not supply valid ${name}`);
  }
  return value;
}

function requiredProofCoordinate(name: string): string {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw new Error(`trusted real-topology runner did not supply valid ${name}`);
  }
  return value;
}

const PROOF_RUN_ID = requiredProofEnv(
  "RC_PROOF_RUN_ID",
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const PROOF_HEAD_SHA = requiredProofEnv("RC_PROOF_HEAD_SHA", /^[0-9a-f]{40}$/);
const PROOF_DEPLOYMENT_ID = requiredProofEnv("RC_PROOF_GITHUB_DEPLOYMENT_ID", /^[1-9][0-9]*$/);
const PROOF_TRUSTED_ORIGIN = requiredProofEnv(
  "RC_PROOF_TRUSTED_ORIGIN",
  /^https:\/\/remote-claw-[a-z0-9]{9}-ejc3-7031s-projects\.vercel\.app$/,
);
const PROOF_ATTESTED_SHA = requiredProofEnv("RC_PROOF_ATTESTED_SHA", /^[0-9a-f]{40}$/);
const PROOF_ATTESTED_ENVIRONMENT = requiredProofEnv("RC_PROOF_ATTESTED_ENVIRONMENT", /^preview$/);
const PROOF_ATTESTED_STORAGE_BACKEND = requiredProofEnv(
  "RC_PROOF_ATTESTED_STORAGE_BACKEND",
  /^sqlite$/,
);
const PROOF_ATTESTED_STORAGE_LOCATOR = requiredProofEnv(
  "RC_PROOF_ATTESTED_STORAGE_LOCATOR",
  /^turso$/,
);
const PROOF_ATTESTED_TURSO_ORGANIZATION = requiredProofCoordinate(
  "RC_PROOF_ATTESTED_TURSO_ORGANIZATION",
);
const PROOF_ATTESTED_TURSO_GROUP = requiredProofCoordinate("RC_PROOF_ATTESTED_TURSO_GROUP");
const PROOF_ATTESTED_TURSO_SCOPE = requiredProofEnv(
  "RC_PROOF_ATTESTED_TURSO_SCOPE",
  /^pr-[0-9a-f]{7}$/,
);
const PACKED_TARBALL_PATH = requiredProofEnv("RC_PROOF_PACKED_TARBALL_PATH", /^\/.+\.tgz$/);
const PACKED_TARBALL_SHA256 = requiredProofEnv("RC_PROOF_PACKED_TARBALL_SHA256", /^[0-9a-f]{64}$/);
const PROOF_WAF_CONFIG_ID = requiredProofEnv("RC_PROOF_WAF_CONFIG_ID", /^waf_TG8xDULMuMuR$/);
const PROOF_WAF_CONFIG_VERSION = Number(requiredProofEnv("RC_PROOF_WAF_CONFIG_VERSION", /^3$/));
const PROOF_WAF_RULE_ID = requiredProofEnv(
  "RC_PROOF_WAF_RULE_ID",
  /^rule_handoff_per_ip_rate_limit_UWaS5F$/,
);
const PLAINTEXT_SCAN_NEEDLE = requiredProofEnv(
  "RC_PROOF_PLAINTEXT_SCAN_NEEDLE",
  /^RC_PLAINTEXT_SCAN_[0-9a-f]{32}$/,
);
const LOG_CANARY_BEGIN = requiredProofEnv(
  "RC_PROOF_LOG_CANARY_BEGIN",
  /^RC_RELEASE_PROOF_LOG_BEGIN_[0-9a-f]{32}$/,
);
const LOG_CANARY_END = requiredProofEnv(
  "RC_PROOF_LOG_CANARY_END",
  /^RC_RELEASE_PROOF_LOG_END_[0-9a-f]{32}$/,
);
const PROOF_WINDOW_STARTED_AT_MS = Number(
  requiredProofEnv("RC_PROOF_WINDOW_STARTED_AT_MS", /^[1-9][0-9]{12}$/),
);
const RECEIPT_FILE = requiredProofEnv("RC_PROOF_RECEIPT_FILE", /^\/.+\.json$/);
const OPERATOR_REPOSITORY_ROOT = requiredProofEnv("RC_PROOF_OPERATOR_REPOSITORY_ROOT", /^\/.+/);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface InstalledCli {
  readonly executable: string;
  readonly packedTarballSha256: string;
}

function trustedExecutable(path: string, label: string): string {
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(path);
    const stat = lstatSync(resolvedPath);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o111) === 0 ||
      (stat.mode & 0o022) !== 0 ||
      (currentUid !== undefined && stat.uid !== 0 && stat.uid !== currentUid)
    ) {
      throw new Error("unsafe");
    }
  } catch {
    throw new Error(`${label} is not an available trusted executable`);
  }
  return resolvedPath;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function installedCli(proofRoot: string): InstalledCli {
  const tarballPath = resolve(PACKED_TARBALL_PATH);
  if (tarballPath.startsWith(`${REPOSITORY_ROOT}${sep}`)) {
    throw new Error("pinned-HEAD CLI tarball is inside the mutable checkout");
  }
  const tarballStat = lstatSync(tarballPath);
  if (
    !tarballStat.isFile() ||
    tarballStat.isSymbolicLink() ||
    (tarballStat.mode & 0o777) !== 0o400 ||
    tarballStat.size < 1 ||
    tarballStat.size > 64 * 1_024 * 1_024 ||
    (typeof process.getuid === "function" && tarballStat.uid !== process.getuid())
  ) {
    throw new Error("pinned-HEAD CLI tarball is not a private immutable regular file");
  }
  const packedTarballSha256 = sha256File(tarballPath);
  if (packedTarballSha256 !== PACKED_TARBALL_SHA256) {
    throw new Error("pinned-HEAD CLI tarball digest does not match the trusted runner");
  }
  const consumer = join(proofRoot, "consumer");
  const installHome = join(proofRoot, "install-home");
  mkdirSync(installHome, { mode: 0o700 });
  const node = trustedExecutable(NODE_BIN, "system Node.js");
  const npm = trustedExecutable(NPM_BIN, "system npm");
  execFileSync(
    node,
    [
      npm,
      "install",
      "--prefix",
      consumer,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    {
      cwd: proofRoot,
      env: { CI: "1", HOME: installHome, LANG: "C.UTF-8", PATH: TRUSTED_PATH },
      stdio: "ignore",
    },
  );
  if (sha256File(tarballPath) !== PACKED_TARBALL_SHA256) {
    throw new Error("pinned-HEAD CLI tarball changed while it was installed");
  }
  const executable = join(consumer, "node_modules", "remote-claw", "dist", "remote-claw.js");
  trustedExecutable(executable, "installed remote-claw");
  return {
    executable,
    packedTarballSha256,
  };
}

interface PinnedClaude {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly executableSha256: string;
  readonly binaryBytes: number;
  readonly resolvedExecutablePath: string;
}

function pinnedClaudeTuple(): PinnedClaude {
  if (process.platform !== PINNED_CLAUDE_PLATFORM || process.arch !== PINNED_CLAUDE_ARCH) {
    throw new Error("real-topology proof is outside the pinned Claude host tuple");
  }
  const resolvedExecutablePath = trustedExecutable(CLAUDE_BIN, "pinned Claude executable");
  const binaryStat = lstatSync(resolvedExecutablePath);
  const executableSha256 = sha256File(resolvedExecutablePath);
  if (
    binaryStat.size !== PINNED_CLAUDE_BINARY_BYTES ||
    executableSha256 !== PINNED_CLAUDE_EXECUTABLE_SHA256
  ) {
    throw new Error("real-topology proof Claude executable bytes are not pinned");
  }
  let version: string;
  try {
    version = execFileSync(CLAUDE_BIN, ["--version"], {
      encoding: "utf8",
      env: { PATH: TRUSTED_PATH },
      maxBuffer: 4_096,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error("real-topology proof could not verify the pinned Claude tuple");
  }
  if (version !== PINNED_CLAUDE_VERSION) {
    throw new Error("real-topology proof is outside the pinned Claude host tuple");
  }
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    executableSha256,
    binaryBytes: binaryStat.size,
    resolvedExecutablePath,
  };
}

function writeReceiptDraft(receipt: unknown): void {
  const compactRunId = PROOF_RUN_ID.replaceAll("-", "");
  const receiptRoot = resolve(OPERATOR_REPOSITORY_ROOT, "tests/web/test-results");
  const expectedPath = join(
    receiptRoot,
    `real-topology-browser-leg-${PROOF_HEAD_SHA}-${compactRunId}.json`,
  );
  if (resolve(RECEIPT_FILE) !== expectedPath) {
    throw new Error("trusted real-topology runner supplied an invalid receipt path");
  }
  preparePrivateReceiptDirectory(receiptRoot);
  writeDurableReceiptFile(expectedPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function createPass(executable: string, secretFile: string, cwd: string): string {
  const commandEnv = { PATH: TRUSTED_PATH };
  execFileSync(executable, ["--rc-identity", "--rc-file", secretFile, "--rc-quiet"], {
    cwd,
    stdio: "ignore",
    env: commandEnv,
  });
  const pass = execFileSync(executable, ["--rc-pass", "--rc-file", secretFile, "--rc-quiet"], {
    cwd,
    encoding: "utf8",
    env: commandEnv,
  }).trim();
  if (!pass.startsWith("rcp1_")) throw new Error("installed CLI did not issue a viewer pass");
  return pass;
}

function launchInstalled(
  executable: string,
  secretFile: string,
  cwd: string,
  brokerUrl: string,
): ChildProcess {
  const argv = [
    executable,
    "--rc-app",
    brokerUrl,
    "--rc-file",
    secretFile,
    // The installed proof needs native RC + inference only. Disabling customizations and tools keeps
    // the already-trusted Claude cwd read-only while still exercising the exact remote text path.
    ...RELEASE_CLAUDE_ARGUMENTS,
  ];
  const home = process.env.HOME;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!home?.startsWith("/")) throw new Error("trusted wrapper HOME is invalid");
  if (!bypass?.trim()) throw new Error("trusted wrapper bypass credential is missing");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: TRUSTED_PATH,
    TERM: "xterm-256color",
    RC_CLAUDE_BIN: CLAUDE_BIN,
    VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
    // The credential-bearing release proof is intentionally artifact-free even when the invoking
    // shell normally enables wire diagnostics. Keep only warning/error diagnostics on discarded
    // stderr and prevent an inherited file sink from persisting prompt/response bodies.
    RC_LOG: "warn",
  };
  for (const key of [
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "TZ",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  const script = trustedExecutable(SCRIPT_BIN, "system PTY launcher");
  return spawn(script, ["-qefc", `exec ${argv.map(shellQuote).join(" ")}`, "/dev/null"], {
    cwd,
    detached: true,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function childPids(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isSafeInteger);
  } catch {
    return [];
  }
}

function descendants(pid: number): number[] {
  const found: number[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const child of childPids(current)) {
      if (found.includes(child)) continue;
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

function attestPinnedClaudeProcess(pid: number, claude: PinnedClaude): boolean {
  const processExecutable = `/proc/${pid}/exe`;
  let resolvedPath: string;
  try {
    resolvedPath = readlinkSync(processExecutable);
  } catch {
    return false;
  }
  if (resolvedPath !== claude.resolvedExecutablePath) return false;
  // The installed CLI first executes this same pinned inode with `--version`. Select only the exact
  // long-lived release payload before hashing 332 MB, so a vanished compatibility probe is a
  // noncandidate while every byte/environment failure on the real payload remains fatal.
  if (!matchesReleaseClaudeProcessArguments(pid, RELEASE_CLAUDE_ARGUMENTS)) return false;
  const stat = statSync(processExecutable);
  if (
    stat.size !== claude.binaryBytes ||
    sha256File(processExecutable) !== claude.executableSha256
  ) {
    throw new Error("running Claude descendant does not have the pinned executable bytes");
  }
  attestReleaseCleanProcessEnvironment(pid);
  return true;
}

function claudePid(scriptPid: number, claude: PinnedClaude): number | undefined {
  for (const pid of descendants(scriptPid)) {
    if (attestPinnedClaudeProcess(pid, claude)) return pid;
  }
  return undefined;
}

async function waitForPinnedClaude(
  child: ChildProcess,
  claude: PinnedClaude,
  timeoutMs: number,
): Promise<number> {
  if (child.pid === undefined) throw new Error("installed wrapper has no process id");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("installed wrapper exited before pinned Claude was observed");
    }
    const pid = claudePid(child.pid, claude);
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("pinned Claude process was not found below the installed CLI PTY");
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

interface PlannedRotationObserver {
  readonly observedAndReconnected: Promise<{ observedElapsedMs: number }>;
  stop(): void;
}

/** Observe only ciphertext-bearing session stream responses. The proof resolves after one response
 * ends with the exact planned-rotation marker and a later session subscription receives HTTP 200. */
function observePlannedSessionRotation(page: Page): PlannedRotationObserver {
  let stopped = false;
  let requestOrdinal = 0;
  let rotationOrdinal: number | null = null;
  let rotationElapsedMs: number | null = null;
  const ordinals = new WeakMap<PlaywrightRequest, number>();
  const responseOpenedAt = new Map<number, number>();
  const successfulResponses = new Set<number>();
  let resolveObserved: (result: { observedElapsedMs: number }) => void = () => {};
  const observedAndReconnected = new Promise<{ observedElapsedMs: number }>((resolve) => {
    resolveObserved = resolve;
  });
  const isSessionStream = (urlString: string): boolean => {
    const url = new URL(urlString);
    return url.pathname === "/api/stream" && url.searchParams.has("session");
  };
  const maybeResolve = (): void => {
    const observedRotationOrdinal = rotationOrdinal;
    if (
      observedRotationOrdinal !== null &&
      rotationElapsedMs !== null &&
      [...successfulResponses].some((ordinal) => ordinal > observedRotationOrdinal)
    ) {
      resolveObserved({ observedElapsedMs: rotationElapsedMs });
    }
  };
  const onRequest = (request: PlaywrightRequest): void => {
    if (!isSessionStream(request.url())) return;
    requestOrdinal += 1;
    ordinals.set(request, requestOrdinal);
  };
  const onResponse = (response: import("@playwright/test").Response): void => {
    if (!isSessionStream(response.url())) return;
    const ordinal = ordinals.get(response.request());
    if (ordinal === undefined) return;
    if (response.status() === 200) {
      successfulResponses.add(ordinal);
      responseOpenedAt.set(ordinal, performance.now());
    }
    maybeResolve();
    void response
      .body()
      .then((body) => {
        try {
          if (stopped || response.status() !== 200) return;
          const text = body.toString("utf8");
          if (text.startsWith(": open\n\n") && text.endsWith(": rotate\n\n")) {
            const openedAt = responseOpenedAt.get(ordinal);
            if (openedAt === undefined) return;
            rotationOrdinal = ordinal;
            rotationElapsedMs = Math.round(performance.now() - openedAt);
            maybeResolve();
          }
        } finally {
          body.fill(0);
        }
      })
      .catch(() => undefined);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    observedAndReconnected,
    stop() {
      stopped = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

async function withProofTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop only the real Claude payload first. Killing the whole PTY group would also kill the installed
 * wrapper before its finally block could publish session_terminal. */
async function stopClaudeGracefully(
  child: ChildProcess,
  pid: number,
  claude: PinnedClaude,
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    throw new Error("installed wrapper exited before the pinned Claude shutdown proof");
  }
  if (!descendants(child.pid).includes(pid) || !attestPinnedClaudeProcess(pid, claude)) {
    throw new Error("pinned Claude process was not found below the installed CLI PTY");
  }
  process.kill(pid, "SIGTERM");
  if (!(await waitForExit(child, 20_000))) {
    throw new Error("installed wrapper did not finish after real Claude exited");
  }
}

async function terminateProcessGroup(child: ChildProcess | null): Promise<void> {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForExit(child, 15_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test("installed CLI + real Claude + deployed broker default + browser complete turns across one planned rotation", async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("Playwright supplied no deployed baseURL");
  if (new URL(baseURL).origin !== PROOF_TRUSTED_ORIGIN) {
    throw new Error("Playwright baseURL does not equal the trusted deployment origin");
  }
  if (
    PROOF_ATTESTED_SHA !== PROOF_HEAD_SHA ||
    PROOF_ATTESTED_ENVIRONMENT !== "preview" ||
    PROOF_ATTESTED_STORAGE_BACKEND !== "sqlite" ||
    PROOF_ATTESTED_STORAGE_LOCATOR !== "turso" ||
    PROOF_ATTESTED_TURSO_SCOPE !== `pr-${PROOF_HEAD_SHA.slice(0, 7)}`
  ) {
    throw new Error("runtime deployment/storage attestation is not bound to the proof HEAD");
  }
  if (PLAINTEXT_SCAN_NEEDLE !== `RC_PLAINTEXT_SCAN_${PROOF_RUN_ID.replaceAll("-", "")}`) {
    throw new Error("plaintext-scan needle is not bound to the proof run id");
  }
  const compactRunId = PROOF_RUN_ID.replaceAll("-", "");
  if (
    LOG_CANARY_BEGIN !== `RC_RELEASE_PROOF_LOG_BEGIN_${compactRunId}` ||
    LOG_CANARY_END !== `RC_RELEASE_PROOF_LOG_END_${compactRunId}` ||
    !Number.isSafeInteger(PROOF_WINDOW_STARTED_AT_MS)
  ) {
    throw new Error("proof log canaries/window are not bound to the proof run id");
  }
  if (!CLAUDE_CWD) throw new Error("RC_PROVE_CLAUDE_CWD is required for the real-topology proof");
  if (!existsSync(CLAUDE_CWD)) throw new Error("RC_PROVE_CLAUDE_CWD does not exist");
  const proofRoot = mkdtempSync(join(tmpdir(), "remote-claw-real-topology-"));
  let child: ChildProcess | null = null;
  let pinnedClaudePid: number | null = null;
  let observedRotationElapsedMs: number | null = null;
  try {
    const claude = pinnedClaudeTuple();
    await primeVercelBypass(page.context(), baseURL, process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
    const installed = installedCli(proofRoot);
    const secretFile = join(proofRoot, "identity");
    const pass = createPass(installed.executable, secretFile, proofRoot);
    child = launchInstalled(installed.executable, secretFile, CLAUDE_CWD, baseURL);
    let childFailure: Error | null = null;
    child.once("error", (error) => {
      childFailure = error;
    });
    pinnedClaudePid = await waitForPinnedClaude(child, claude, 30_000);
    const assertChildAlive = () => {
      if (childFailure !== null) throw childFailure;
      if (child?.exitCode !== null || child?.signalCode !== null) {
        throw new Error("installed remote-claw exited before the real-topology proof completed");
      }
    };

    await page.goto("/");
    await page.evaluate((encodedPass) => {
      window.location.hash = encodedPass;
    }, encodeURIComponent(pass));
    await page.getByRole("button", { name: "Connect" }).click();
    const row = page.locator("button.row").first();
    await expect(row).toBeVisible();
    assertChildAlive();
    await expect(row).toHaveAttribute("data-state", "connected");
    await expect(row.locator(".agent-badge")).toHaveText("Claude Code · RC");
    await row.click();

    await expect(page.locator(".local-input-disclosure")).toContainText(
      "Prompts entered in the local Claude terminal may not appear here.",
    );
    await expect(page.locator(".perms-local")).toHaveText("permissions local");
    await expect(page.getByTestId("composer-mode")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Attach photos" })).toBeDisabled();
    await page.locator("button.chat-menu").click();
    await expect(page.locator(".sheet .mode-row-danger")).toBeDisabled();
    await page.keyboard.press("Escape");

    const prompt = `Reply with exactly: ${PLAINTEXT_SCAN_NEEDLE}`;
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const user = page.locator(".row-user", { hasText: prompt });
    await expect(user.locator('.delivery-status[data-state="received"]')).toHaveText(
      "Received by host",
    );
    await expect(
      page.locator(".prose.assistant", {
        hasText: PLAINTEXT_SCAN_NEEDLE,
      }),
    ).toBeVisible({
      timeout: 180_000,
    });
    assertChildAlive();

    // A browser reconnect must replay the same durable projection from the deployed SQLite store.
    await page.reload();
    const replayedRow = page.locator("button.row").first();
    await expect(replayedRow).toHaveAttribute("data-state", "connected");
    const rotation = observePlannedSessionRotation(page);
    await replayedRow.click();
    try {
      await expect(
        page.locator(".prose.assistant", {
          hasText: PLAINTEXT_SCAN_NEEDLE,
        }),
      ).toBeVisible();
      const rotationEvidence = await withProofTimeout(
        rotation.observedAndReconnected,
        ROTATION_PROOF_TIMEOUT_MS,
        "deployed browser did not observe and reconnect after planned stream rotation",
      );
      if (
        rotationEvidence.observedElapsedMs < 235_000 ||
        rotationEvidence.observedElapsedMs > 270_000
      ) {
        throw new Error("deployed stream rotation elapsed time is outside the release-proof bound");
      }
      observedRotationElapsedMs = rotationEvidence.observedElapsedMs;
    } finally {
      rotation.stop();
    }
    assertChildAlive();
    if (pinnedClaudePid === null || !attestPinnedClaudeProcess(pinnedClaudePid, claude)) {
      throw new Error("pinned Claude process did not survive planned stream rotation");
    }

    // The browser's observed reconnect is only one half of the topology. A second prompt on the SAME
    // cse after that boundary proves the installed host independently re-subscribed and remained usable.
    const postRotationReply = `${PLAINTEXT_SCAN_NEEDLE}_AFTER_ROTATION`;
    const postRotationPrompt = `Reply with exactly: ${postRotationReply}`;
    await page.getByRole("textbox", { name: "Message" }).fill(postRotationPrompt);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const postRotationUser = page.locator(".row-user", {
      hasText: postRotationPrompt,
    });
    await expect(postRotationUser.locator('.delivery-status[data-state="received"]')).toHaveText(
      "Received by host",
    );
    await expect(page.locator(".prose.assistant", { hasText: postRotationReply })).toBeVisible({
      timeout: 180_000,
    });
    assertChildAlive();

    // Normal host exit publishes the authenticated absorbing terminal marker. The dead row disappears,
    // but the UI must preserve the release disclosure instead of making the lifecycle fact vanish.
    if (child === null) throw new Error("installed wrapper process was not created");
    if (pinnedClaudePid === null) {
      throw new Error("pinned Claude process was not attested");
    }
    await stopClaudeGracefully(child, pinnedClaudePid, claude);
    await expect(page.locator("button.row")).toHaveCount(0, {
      timeout: 45_000,
    });
    await expect(page.locator(".terminal-notice")).toContainText(
      "Session ended — its most recent delivery and output tail may be incomplete.",
    );
    const activeBrowser = page.context().browser();
    if (activeBrowser === null) {
      throw new Error("real-topology proof has no active browser");
    }
    if (observedRotationElapsedMs === null) {
      throw new Error("measured stream rotation evidence is missing");
    }
    writeReceiptDraft({
      schema: RECEIPT_SCHEMA,
      runId: PROOF_RUN_ID,
      headSha: PROOF_HEAD_SHA,
      githubDeploymentId: PROOF_DEPLOYMENT_ID,
      trustedOrigin: PROOF_TRUSTED_ORIGIN,
      runtimeAttestation: {
        environment: PROOF_ATTESTED_ENVIRONMENT,
        sha: PROOF_ATTESTED_SHA,
        storage: {
          backend: PROOF_ATTESTED_STORAGE_BACKEND,
          locator: PROOF_ATTESTED_STORAGE_LOCATOR,
          organization: PROOF_ATTESTED_TURSO_ORGANIZATION,
          group: PROOF_ATTESTED_TURSO_GROUP,
          scope: PROOF_ATTESTED_TURSO_SCOPE,
        },
      },
      inspectionStatus: "pending",
      logCanaries: {
        begin: LOG_CANARY_BEGIN,
        end: LOG_CANARY_END,
      },
      proofWindow: {
        startedAtMs: PROOF_WINDOW_STARTED_AT_MS,
        completedAtMs: null,
      },
      packedTarballSha256: installed.packedTarballSha256,
      edgeRateLimit: {
        projectId: VERCEL_PROJECT_ID,
        teamId: VERCEL_TEAM_ID,
        firewallConfigId: PROOF_WAF_CONFIG_ID,
        firewallConfigVersion: PROOF_WAF_CONFIG_VERSION,
        ruleId: PROOF_WAF_RULE_ID,
        ruleName: WAF_RULE_NAME,
        pathPrefix: "/api/handoff",
        algorithm: "token_bucket",
        limit: 20,
        windowSeconds: 60,
        key: "ip",
        excessAction: "deny",
        firewallBypassCount: 0,
      },
      claude: {
        version: claude.version,
        platform: claude.platform,
        arch: claude.arch,
        executableSha256: claude.executableSha256,
        binaryBytes: claude.binaryBytes,
      },
      browser: {
        name: activeBrowser.browserType().name(),
        version: activeBrowser.version(),
        project: testInfo.project.name,
        result: "assertions_passed",
      },
      streamRotation: {
        marker: "rotate",
        routeRotateMs: PLANNED_STREAM_ROTATION_MS,
        observedElapsedMs: observedRotationElapsedMs,
        browserObserved: true,
        browserReconnected: true,
        postRotationTurn: "assertions_passed",
      },
      plaintextScanNeedle: PLAINTEXT_SCAN_NEEDLE,
    });
  } finally {
    await terminateProcessGroup(child);
    rmSync(proofRoot, { recursive: true, force: true });
  }
});
