import { execFile as nodeExecFile } from "node:child_process";

export const STABLE_CLAUDE_VERSION = "2.1.237 (Claude Code)";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BYTES = 4_096;

export const STABLE_CLAUDE_REQUIREMENT = `stable --rc-app requires Claude ${STABLE_CLAUDE_VERSION}`;

export type ClaudeVersionReader = (claudeBin: string) => Promise<string>;

export function compatibilityProbeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  // These values belong to the wrapper and must not reach even the short-lived probe child.
  delete env.REMOTE_CLAW_SECRET_FILE;
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

function readClaudeVersion(claudeBin: string): Promise<string> {
  const env = compatibilityProbeEnv(process.env);
  return new Promise((resolve, reject) => {
    nodeExecFile(
      claudeBin,
      ["--version"],
      {
        encoding: "utf8",
        env,
        maxBuffer: VERSION_PROBE_MAX_BYTES,
        timeout: VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Claude compatibility probe failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface StableClaudeCompatibilityOptions {
  readonly readVersion?: ClaudeVersionReader;
}

/**
 * Fail closed before stable MITM startup unless Claude reports the supported protocol version.
 * The private RC parser still validates every message shape at runtime. We deliberately trust the
 * user's local executable and OS: a same-user or root compromise can already replace this wrapper,
 * its credentials, and its dependencies, so byte/owner/inode attestation added friction without a
 * meaningful product security boundary.
 */
export async function assertStableClaudeCompatibility(
  claudeBin: string,
  options: StableClaudeCompatibilityOptions = {},
): Promise<void> {
  let version: string;
  try {
    version = await (options.readVersion ?? readClaudeVersion)(claudeBin);
  } catch {
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }
  if (version.trim() !== STABLE_CLAUDE_VERSION) {
    throw new Error(STABLE_CLAUDE_REQUIREMENT);
  }
}
