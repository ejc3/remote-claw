import {
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import { type Carried, CLOSE_SIGNAL, PUBLISH_SIGNAL, type RelayState, STATE_QUERY } from "./names";

// The Temporal durable backend's equivalent of the Vercel relayWorkflow / the LocalBackend channel:
// ONE workflow per channel token (workflowId = token). publish appends to an in-workflow frame log;
// subscribe (in the backend) polls the `state` query for frames since a cursor; close completes the
// run, which frees the workflowId for a fresh signalWithStart (the cap-roll handoff). Querying a
// completed workflow still returns its final state, so a subscriber drains the tail then sees closed.
//
// History bounding: a publish stream grows the run's event history (Temporal's analogue of the Vercel
// per-run event cap). When Temporal suggests it, we continueAsNew carrying the FULL frame log forward
// so a resuming subscriber's absolute cursor stays valid while history resets. (A channel's total
// frames must fit Temporal's payload limit — true for RC sessions; an unbounded stream would window.)
// Frames are opaque (the broker never decrypts).

const publish = defineSignal<[unknown]>(PUBLISH_SIGNAL);
const close = defineSignal<[]>(CLOSE_SIGNAL);
const state = defineQuery<RelayState, [number]>(STATE_QUERY);

export async function relayChannel(token: string, carried?: Carried): Promise<void> {
  const frames: unknown[] = carried ? [...carried.frames] : [];
  let closed = carried?.closed ?? false;

  setHandler(publish, (frame) => {
    frames.push(frame);
  });
  setHandler(close, () => {
    closed = true;
  });
  setHandler(state, (since) => ({
    frames: frames.slice(Math.max(0, since)),
    total: frames.length,
    closed,
  }));

  // Run until closed, or until Temporal suggests rolling history.
  await condition(() => closed || workflowInfo().continueAsNewSuggested);
  // Let every in-flight signal handler finish so a publish/close delivered right at the boundary is
  // applied before we complete or roll — otherwise its frame would be dropped (a permanent gap).
  await condition(allHandlersFinished);
  if (closed) return; // run completes → the workflowId frees for the next signalWithStart on this token
  await continueAsNew<typeof relayChannel>(token, { frames, closed });
}
