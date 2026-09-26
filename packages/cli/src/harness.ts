// Browser-safe harness metadata. No native client, Node import, discovery, or dynamic plugin loading.
// Adding a harness means declaring its semantics here and implementing its native adapter separately.

/** Exact 2.1.237 native mention boundaries. These references can ingest host files/resources before
 * a Read approval. Browser text/captions must not introduce them; uploaded bytes get host-owned
 * references only after validation. Ordinary email addresses are not mention tokens. */
export function hasClaudeNativeReferences(text: string): boolean {
  return (
    /(^|[\s\u3002\u3001\uFF1F\uFF01])@"[^"]+"/.test(text) ||
    /(^|[\s\u3002\u3001\uFF1F\uFF01])@[^\s]+\b/.test(text)
  );
}

/** Captured Claude file decisions only. Large or unfamiliar edits remain native-owned. */
export type NativeFileInput =
  | { tool: "Read"; input: { file_path: string } }
  | { tool: "Write"; input: { file_path: string; content: string } }
  | {
      tool: "Edit";
      input: { file_path: string; old_string: string; new_string: string; replace_all: false };
    };

export function parseNativeFileInput(tool: unknown, raw: unknown): NativeFileInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (
    typeof input.file_path !== "string" ||
    input.file_path.trim() === "" ||
    input.file_path.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(input.file_path)
  )
    return null;
  const keys = Object.keys(input);
  const exact = (allowed: readonly string[]) =>
    keys.length === allowed.length && keys.every((key) => allowed.includes(key));
  let result: NativeFileInput;
  if (tool === "Read" && exact(["file_path"])) {
    result = { tool, input: { file_path: input.file_path } };
  } else if (
    tool === "Write" &&
    exact(["file_path", "content"]) &&
    typeof input.content === "string"
  ) {
    result = { tool, input: { file_path: input.file_path, content: input.content } };
  } else if (
    tool === "Edit" &&
    exact(["file_path", "old_string", "new_string", "replace_all"]) &&
    typeof input.old_string === "string" &&
    input.old_string !== "" &&
    typeof input.new_string === "string" &&
    input.replace_all === false
  ) {
    result = {
      tool,
      input: {
        file_path: input.file_path,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: false,
      },
    };
  } else return null;
  return new TextEncoder().encode(JSON.stringify(result.input)).byteLength <= 32 * 1024
    ? result
    : null;
}

export interface NativePatchInput {
  changes: { path: string; operation: "add" | "delete" | "update"; diff: string }[];
}

/** Complete, bounded native patch previews only; never turn an omitted diff into an approval. */
export function parseNativePatchInput(raw: unknown): NativePatchInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    !Array.isArray(input.changes) ||
    input.changes.length < 1 ||
    input.changes.length > 20
  )
    return null;
  const changes: NativePatchInput["changes"] = [];
  const paths = new Set<string>();
  for (const rawChange of input.changes) {
    if (typeof rawChange !== "object" || rawChange === null || Array.isArray(rawChange))
      return null;
    const change = rawChange as Record<string, unknown>;
    if (
      Object.keys(change).length !== 3 ||
      !Object.keys(change).every((key) => ["path", "operation", "diff"].includes(key)) ||
      typeof change.path !== "string" ||
      change.path.length > 4096 ||
      /[\p{Cc}\p{Cf}]/u.test(change.path) ||
      !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(change.path) ||
      paths.has(change.path) ||
      (change.operation !== "add" &&
        change.operation !== "delete" &&
        change.operation !== "update") ||
      typeof change.diff !== "string" ||
      (change.operation === "update" && change.diff === "")
    )
      return null;
    paths.add(change.path);
    changes.push({ path: change.path, operation: change.operation, diff: change.diff });
  }
  const result = { changes };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 32 * 1024 ? result : null;
}

export interface ControlCapabilities {
  interrupt: boolean;
  setModel: boolean;
  setMode: boolean;
  end: boolean;
}

export interface DriverCapabilities {
  structuredPermissions: boolean;
  /** Native choice forms are an independently qualified subset of structured permissions. */
  structuredQuestions?: boolean;
  /** Native first-response-wins decisions close only on provider resolution, not broker admission. */
  permissionResolution?: "native";
  permissionPosture?: "local" | "bypassed" | "unknown";
  status: boolean;
  controls: ControlCapabilities;
  attachments: boolean;
  /** General host-owned file inputs; omission preserves older image-only hosts. */
  files?: boolean;
  /** Independent of optional controls/attachments; omission is only for older hosts. */
  textInput?: "plain" | "terminal";
}

export interface HarnessDescriptor {
  agent: string;
  mode: string;
}

export interface HarnessMetadata {
  descriptor: HarnessDescriptor;
  label: string;
  shortLabel: string;
  detail: string;
  localUi: string;
  ordering: "native" | "relay";
  requireDurable: boolean;
  textInput: "plain" | "terminal" | "legacy" | "blocked";
  preserveText: boolean;
}

export const HARNESSES = {
  mitm: {
    descriptor: { agent: "claude-code", mode: "rc" },
    label: "Claude Code",
    shortLabel: "Claude",
    detail: "Private relay",
    localUi: "Claude terminal",
    ordering: "relay",
    requireDurable: false,
    textInput: "legacy",
    preserveText: false,
  },
  "claude-native": {
    descriptor: { agent: "claude-code", mode: "native-rc" },
    label: "Claude Code",
    shortLabel: "Claude",
    detail: "Anthropic remote control",
    localUi: "Claude terminal",
    ordering: "native",
    requireDurable: true,
    textInput: "plain",
    preserveText: false,
  },
  tmux: {
    descriptor: { agent: "claude-code", mode: "tmux" },
    label: "Claude Code",
    shortLabel: "Claude",
    detail: "Terminal bridge",
    localUi: "Claude tmux pane",
    ordering: "relay",
    requireDurable: false,
    textInput: "terminal",
    preserveText: false,
  },
  opencode: {
    descriptor: { agent: "opencode", mode: "opencode" },
    label: "OpenCode",
    shortLabel: "OpenCode",
    detail: "Native OpenCode session",
    localUi: "OpenCode TUI",
    ordering: "native",
    requireDurable: false,
    textInput: "plain",
    preserveText: true,
  },
  codex: {
    descriptor: { agent: "codex", mode: "app-server" },
    label: "Codex",
    shortLabel: "Codex",
    detail: "Local app-server",
    localUi: "Codex TUI",
    ordering: "native",
    requireDurable: true,
    textInput: "plain",
    preserveText: false,
  },
} as const satisfies Record<string, HarnessMetadata>;

export type DriverName = keyof typeof HARNESSES;
export const MITM_HARNESS = HARNESSES.mitm.descriptor;
export const CLAUDE_NATIVE_HARNESS = HARNESSES["claude-native"].descriptor;
export const TMUX_HARNESS = HARNESSES.tmux.descriptor;
export const OPENCODE_HARNESS = HARNESSES.opencode.descriptor;
export const CODEX_HARNESS = HARNESSES.codex.descriptor;

export const UNKNOWN_HARNESS = { agent: "unknown", mode: "unknown" } as const;
const UNKNOWN_METADATA: HarnessMetadata = {
  descriptor: UNKNOWN_HARNESS,
  label: "Unknown agent",
  shortLabel: "Agent",
  detail: "Unsupported harness",
  localUi: "native terminal",
  ordering: "relay",
  requireDurable: true,
  textInput: "blocked",
  preserveText: false,
};

export function harnessMetadata(harness: HarnessDescriptor | undefined): HarnessMetadata {
  if (harness === undefined) return HARNESSES.mitm; // The only pre-descriptor host was MITM.
  return (
    Object.values(HARNESSES).find(
      ({ descriptor }) => descriptor.agent === harness.agent && descriptor.mode === harness.mode,
    ) ?? UNKNOWN_METADATA
  );
}

/** Absence is legacy MITM; present malformed/unknown descriptors must not inherit its authority. */
export function parseHarnessDescriptor(raw: unknown): HarnessDescriptor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) return UNKNOWN_HARNESS;
  const h = raw as Record<string, unknown>;
  return (
    Object.values(HARNESSES).find(
      ({ descriptor }) => descriptor.agent === h.agent && descriptor.mode === h.mode,
    )?.descriptor ?? UNKNOWN_HARNESS
  );
}

type PolicyCapabilities = Omit<DriverCapabilities, "textInput"> & { textInput?: string };

/** Feature flags never select native ordering or weaken its admission/input boundary. */
export function harnessPolicy(
  harness: HarnessDescriptor | undefined,
  caps: PolicyCapabilities | undefined,
): Pick<HarnessMetadata, "textInput" | "ordering" | "requireDurable"> {
  const metadata = harnessMetadata(harness);
  let textInput = metadata.textInput;
  if (textInput !== "blocked" && caps?.textInput !== undefined) {
    textInput =
      caps.textInput === "plain" || caps.textInput === "terminal" ? caps.textInput : "blocked";
    // A terminal adapter's stricter boundary cannot be weakened by a host announcement.
    if (metadata.textInput === "terminal" && textInput === "plain") textInput = "terminal";
  } else if (
    textInput === "legacy" &&
    caps &&
    !caps.structuredPermissions &&
    !caps.attachments &&
    !caps.controls.interrupt &&
    !caps.controls.setModel &&
    !caps.controls.setMode &&
    !caps.controls.end
  ) {
    // Bounded rolling compatibility for stable MITM hosts predating explicit textInput.
    textInput = "plain";
  }
  return {
    textInput,
    ordering: metadata.ordering,
    requireDurable:
      metadata.requireDurable || (metadata.textInput === "legacy" && textInput !== "legacy"),
  };
}
