// Shared Temporal identifiers for the relay channel, used by BOTH the workflow (which runs in the
// Temporal worker sandbox) and the TemporalBackend (which runs in the Next/Node server). Kept in a
// leaf module with NO @temporalio import so the Node side never pulls in workflow-sandbox code — it
// addresses signals/queries by these string names. A channel token IS the workflow id.

export const WORKFLOW_TYPE = "relayChannel";
export const PUBLISH_SIGNAL = "publish"; // (frame) → append to the channel's frame log
export const CLOSE_SIGNAL = "close"; //     ()      → complete the run, freeing the token
export const STATE_QUERY = "state"; //      (since) → { frames: frames.slice(since), total, closed }

export const DEFAULT_TASK_QUEUE = "relay";
export const DEFAULT_ADDRESS = "127.0.0.1:7233";
export const DEFAULT_NAMESPACE = "default";

/** The relay channel's queryable state from a resume cursor (frames are opaque WireFrames). */
export interface RelayState {
  frames: unknown[];
  total: number;
  closed: boolean;
}

/** State carried across a continueAsNew (history roll) so absolute frame indices stay stable. */
export interface Carried {
  frames: unknown[];
  closed: boolean;
}
