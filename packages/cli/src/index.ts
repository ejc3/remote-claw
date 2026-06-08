// @remote-claw/cli — the transparent wrapper. Public surface grows one unit per PR.
export {
  type Classified,
  classifyArgs,
  RC_FLAGS,
  type RcFlagKind,
  type RcValue,
} from "./args.js";
export { type RunOptions, runWrapper, type SpawnFn } from "./run.js";
