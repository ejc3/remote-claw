// @remote-claw/cli — the transparent wrapper. Public surface grows one unit per PR.
export {
  type Classified,
  classifyArgs,
  RC_FLAGS,
  type RcFlagKind,
  type RcValue,
} from "./args.js";
export { type IdentityOptions, runIdentity } from "./identity.js";
export { type RunOptions, runWrapper, type SpawnFn } from "./run.js";
export {
  type CreatedIdentity,
  ensureIdentity,
  type LoadedIdentity,
  loadSecret,
  type PathSource,
  type ResolvedPath,
  resolveSecretPath,
  type StoreEnv,
  StoreError,
  type StoreErrorCode,
} from "./store.js";
