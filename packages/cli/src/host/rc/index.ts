// The Remote-Control MITM host: the real backend behind the wrapper (§14/§17.5). `claude
// --remote-control` is pointed at MitmProxy via HTTPS_PROXY; the proxy serves the RC worker
// endpoints from RelayCore/Session; HostRcRelay bridges that session to the E2E-encrypted broker.

export type {
  EngineAccess,
  EngineProduct,
  NativeConversationBinding,
  NativeConversationCapabilities,
  NativeConversationLease,
  NativeConversationPhase,
  NativeConversationRef,
  NativeConversationRegistrar,
  NativeEngineAdapter,
  NativeEngineDescriptor,
  NativeMutationFence,
  NativeProjectRef,
} from "../native/index.js";
export {
  AnthropicRcClient,
  type AnthropicRcClientOptions,
  type AnthropicRcEvent,
  type RcEventPage,
  type RcHistoryOptions,
  type RcListOptions,
  type RcPostAck,
  type RcRequestOptions,
  type RcSequenceNum,
  type RcSessionPage,
  type RcSessionSummary,
  type RcSseEventItem,
  type RcSseFrameItem,
  type RcSseItem,
  type RcUserEventInput,
} from "./anthropic/client.js";
export {
  AnthropicRcError,
  type AnthropicRcErrorKind,
} from "./anthropic/errors.js";
export type {
  AnthropicRcTransport,
  AnthropicRcTransportRequest,
  RcOAuthAccessTokenOptions,
  RcOAuthProvider,
} from "./anthropic/transport.js";
export { type CertPaths, certPaths, ensureCerts, MITM_HOST } from "./certs.js";
export {
  type ContentBlock,
  type ControlCapabilities,
  type Driver,
  type DriverCapabilities,
  type DriverContext,
  type DriverFactory,
  type DriverName,
  type HarnessDescriptor,
  MITM_CAPABILITIES,
  MITM_HARNESS,
  OPENCODE_HARNESS,
  TMUX_HARNESS,
  type UpstreamPayload,
} from "./driver.js";
export {
  type BridgeAnnouncement,
  type BridgeArgs,
  type BridgeSessionHandle,
  bridgeSession,
  startBridgeSession,
} from "./drivers/bridge.js";
export {
  type LegacyRcConversationMetadata,
  LegacyRcConversationRegistrar,
  type LegacyRcRegistrarOptions,
} from "./drivers/legacy-registrar.js";
export { type GitInfo, gitInfo, parseGitStatusV2 } from "./gitinfo.js";
export { type RcLaunchOptions, runRcLaunch, type SpawnClaudeEnv } from "./launch.js";
export { type MitmOptions, MitmProxy, splitAuthority } from "./mitm.js";
export { HostRcRelay, type HostRcRelayOptions } from "./relay.js";
export {
  assistantText,
  type EventSource,
  permissionModeFrom,
  RcEvent,
  RelayCore,
  Session,
  type SessionOptions,
} from "./session.js";
// The tmux driver (Track B): drive a plain claude in a tmux pane, bridge via the transcript JSONL.
export {
  buildChildEnv,
  runTmuxDriver,
  shellQuoteCommand,
  TMUX_CAPABILITIES,
  type TmuxDriverDeps,
  tmuxDriver,
} from "./tmux/driver.js";
export {
  downstreamUserText,
  INJECT_BUFFER,
  injectUserText,
  isInterrupt,
  PASTE_SETTLE_MS,
  runInjectPump,
} from "./tmux/inject.js";
export { IDLE_DEBOUNCE_MS, nodeTimer, StatusTracker, type Timer } from "./tmux/status.js";
export {
  realTmuxExec,
  TmuxCtl,
  TmuxError,
  type TmuxExec,
  type TmuxExecResult,
} from "./tmux/tmuxctl.js";
export {
  findNewestTranscript,
  projectDir,
  projectSlug,
  splitLines,
  TranscriptTailer,
  transcriptPath,
  transcriptToPayload,
} from "./tmux/transcript.js";
