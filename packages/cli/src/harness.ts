// Browser-safe harness metadata. No native client, Node import, discovery, or dynamic plugin loading.
// Adding a harness means declaring its semantics here and implementing its native adapter separately.

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
