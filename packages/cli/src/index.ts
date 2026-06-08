// @remote-claw/cli — the transparent wrapper. Public surface grows one unit per PR.
export {
  type Classified,
  classifyArgs,
  RC_FLAGS,
  type RcFlagKind,
  type RcValue,
} from "./args.js";
export { type IdentityOptions, runIdentity } from "./identity.js";
export { type PassOptions, runPass } from "./pass.js";
export { type RunOptions, runWrapper, type SpawnFn } from "./run.js";
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
