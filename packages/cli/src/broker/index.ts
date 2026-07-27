// The browser-safe broker surface, exposed as `@remote-claw/cli/broker`. Everything here imports
// ONLY clawsec + the Web platform (fetch/SSE) — no node:fs / child_process — so the web client can
// reuse the host's exact transport, plane mapping, and SecurityProvider, plus the shared
// FrameOrderer used for viewer transcript projection, with zero wire/security drift. The host's
// inbound command pump deliberately performs direct msg-id dedup instead of transcript ordering.
// (The package's "." barrel pulls in the Node-only CLI bits and is not browser-safe; this subpath is.)

export {
  type Level,
  type Plane,
  type SecurityProvider,
  securityProvider,
} from "../security/provider.js";
export {
  BrokerClient,
  type BrokerClientOptions,
  BrokerError,
  type RelayResult,
  type StreamOptions,
} from "./client.js";
export { FrameOrderer } from "./order.js";
export { CONTENT_KINDS, CONTROL_KINDS, META_KINDS, planeForKind } from "./protocol.js";
