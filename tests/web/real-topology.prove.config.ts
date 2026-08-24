import { defineConfig, devices } from "@playwright/test";

const forbiddenInvocationEnvironment = new Set([
  "init_cwd",
  "node_extra_ca_certs",
  "node_options",
  "node_path",
  "node_tls_reject_unauthorized",
  "npm_config_node_options",
  "npm_config_prefix",
  "npm_config_script_shell",
  "npm_config_userconfig",
  "npm_execpath",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_node_execpath",
  "rc_claude_bin",
  "ssl_cert_dir",
  "ssl_cert_file",
]);
for (const key of Object.keys(process.env)) {
  if (forbiddenInvocationEnvironment.has(key.toLowerCase())) {
    throw new Error(`real-topology proof refuses inherited ${key}`);
  }
}

const baseURL = process.env.WEB_E2E_URL?.trim();
if (!baseURL) throw new Error("WEB_E2E_URL is required for the real-topology proof");
if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()) {
  throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required for the real-topology proof");
}
const allowedEnvironment = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "RC_PROVE_CLAUDE_CWD",
  "RC_PROOF_ATTESTED_ENVIRONMENT",
  "RC_PROOF_ATTESTED_SHA",
  "RC_PROOF_ATTESTED_STORAGE_BACKEND",
  "RC_PROOF_ATTESTED_STORAGE_LOCATOR",
  "RC_PROOF_ATTESTED_TURSO_GROUP",
  "RC_PROOF_ATTESTED_TURSO_ORGANIZATION",
  "RC_PROOF_ATTESTED_TURSO_SCOPE",
  "RC_PROOF_GITHUB_DEPLOYMENT_ID",
  "RC_PROOF_HEAD_SHA",
  "RC_PROOF_LOG_CANARY_BEGIN",
  "RC_PROOF_LOG_CANARY_END",
  "RC_PROOF_PACKED_TARBALL_PATH",
  "RC_PROOF_PACKED_TARBALL_SHA256",
  "RC_PROOF_OPERATOR_REPOSITORY_ROOT",
  "RC_PROOF_PLAINTEXT_SCAN_NEEDLE",
  "RC_PROOF_RECEIPT_FILE",
  "RC_PROOF_RUN_ID",
  "RC_PROOF_TRUSTED_ORIGIN",
  "RC_PROOF_WAF_CONFIG_ID",
  "RC_PROOF_WAF_CONFIG_VERSION",
  "RC_PROOF_WAF_RULE_ID",
  "RC_PROOF_WINDOW_STARTED_AT_MS",
  "TERM",
  "TZ",
  "USER",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "WEB_E2E_URL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
for (const key of Object.keys(process.env)) {
  if (!allowedEnvironment.has(key)) delete process.env[key];
}

const browserEnvironment: Record<string, string> = { PATH: "/usr/bin:/bin" };
for (const key of ["HOME", "LANG", "LC_ALL", "TZ"]) {
  const value = process.env[key];
  if (typeof value === "string" && value !== "") browserEnvironment[key] = value;
}

export default defineConfig({
  testDir: "./app-e2e",
  testMatch: "real-topology.prove.spec.ts",
  timeout: 780_000,
  expect: { timeout: 120_000 },
  outputDir: "./test-results-real-topology",
  workers: 1,
  retries: 0,
  use: {
    baseURL,
    // This proof carries the live Vercel automation-bypass header. Playwright traces retain context
    // options and request headers verbatim, so even failure-only tracing would persist that credential.
    // Keep tracing unconditionally off; the proof's assertions and content-free process errors are the
    // diagnostic boundary for this credential-bearing run.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        launchOptions: { env: browserEnvironment },
      },
    },
  ],
});
