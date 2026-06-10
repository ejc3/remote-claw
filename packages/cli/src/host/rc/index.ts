// The Remote-Control MITM host: the real backend behind the wrapper (§14/§17.5). `claude
// --remote-control` is pointed at MitmProxy via HTTPS_PROXY; the proxy serves the RC worker
// endpoints from RelayCore/Session; HostRcRelay bridges that session to the E2E-encrypted broker.
export { type CertPaths, certPaths, ensureCerts, MITM_HOST } from "./certs.js";
export { type GitInfo, gitInfo, parseGitStatusV2 } from "./gitinfo.js";
export { type RcLaunchOptions, runRcLaunch, type SpawnClaudeEnv } from "./launch.js";
export { type MitmOptions, MitmProxy, splitAuthority } from "./mitm.js";
export { HostRcRelay, type HostRcRelayOptions } from "./relay.js";
export {
  assistantText,
  type EventSource,
  RcEvent,
  RelayCore,
  Session,
  type SessionOptions,
} from "./session.js";
