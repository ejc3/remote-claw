// @remote-claw/cli — the transparent wrapper. Public surface grows one unit per PR.
export {
  type Classified,
  classifyArgs,
  RC_FLAGS,
  type RcFlagKind,
  type RcValue,
} from "./args.js";
export {
  BrokerClient,
  type BrokerClientOptions,
  BrokerError,
  type RelayResult,
  type StreamOptions,
} from "./broker/client.js";
export { FrameOrderer } from "./broker/order.js";
export {
  CONTENT_KINDS,
  CONTROL_KINDS,
  META_KINDS,
  planeForKind,
} from "./broker/protocol.js";
export { type UploadHandoffOptions, uploadHandoff } from "./handoff-upload.js";
export {
  type ClaudeBackend,
  type ClaudeSpawn,
  type ClaudeStreamOptions,
  ClaudeStreamSession,
  type TurnEvent,
} from "./host/claude.js";
export { HostRelay, type HostRelayOptions } from "./host/relay.js";
export { type IdentityOptions, runIdentity } from "./identity.js";
export { type PassOptions, runPass } from "./pass.js";
export {
  type RunOptions,
  type RuntimeOwnerBootstrap,
  type RuntimeOwnerBootstrapInput,
  type RuntimeOwnerCollaborator,
  runWrapper,
  type SpawnFn,
} from "./run.js";
export {
  type Level,
  type Plane,
  type SecurityProvider,
  securityProvider,
} from "./security/provider.js";
export { runShowSecret, type ShowSecretOptions } from "./showsecret.js";
export {
  type CreatedIdentity,
  ensureIdentity,
  type LoadedIdentity,
  loadSecret,
  type PathSource,
  type ResolvedPath,
  type RotatedIdentity,
  resolveSecretPath,
  rotateIdentity,
  type StoreEnv,
  StoreError,
  type StoreErrorCode,
} from "./store.js";
