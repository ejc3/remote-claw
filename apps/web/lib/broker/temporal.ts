import type { WireFrame } from "@remote-claw/clawsec";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { temporalConfig, temporalPollMs } from "../../temporal/connection";
import {
  CLOSE_SIGNAL,
  PUBLISH_SIGNAL,
  type RelayState,
  STATE_QUERY,
  WORKFLOW_TYPE,
} from "../../temporal/names";
import { type BrokerBackend, isClose, type PublishResult, type RelayPayload } from "./backend";

// The Temporal durable backend — a PRODUCTION option (not just dev), selected with
// BROKER_BACKEND=temporal. Each channel token is a `relayChannel` workflow (workflowId = token):
//   publish   = signalWithStart (resume-or-start, atomic) → append to the workflow's frame log.
//   subscribe = poll the `state` query into a ReadableStream → ordered + resumable; null if absent.
//   __close   = signal CLOSE on an existing run (no-op if absent) → completes it, freeing the token.
// Connection settings (address, namespace, TLS / Cloud API key) come from temporalConfig(); the
// relayChannel worker (temporal/worker.ts) must run as a service against the same server. subscribe
// polls (Temporal has no native server→client push for workflow state); the interval is tunable.

export class TemporalBackend implements BrokerBackend {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  readonly #cfg = temporalConfig();
  readonly #pollMs = temporalPollMs();

  async #client_(): Promise<Client> {
    if (this.#client !== null) return this.#client;
    if (this.#connecting === null) {
      this.#connecting = Connection.connect(this.#cfg.connection).then((connection) => {
        this.#client = new Client({ connection, namespace: this.#cfg.namespace });
        return this.#client;
      });
    }
    return this.#connecting;
  }

  async publish(token: string, payload: RelayPayload): Promise<PublishResult> {
    const client = await this.#client_();
    if (isClose(payload)) {
      // Close an EXISTING run only (no signalWithStart — never start a run just to close it). No-op
      // if absent or already completed.
      try {
        await client.workflow.getHandle(token).signal(CLOSE_SIGNAL);
      } catch (e) {
        if (!(e instanceof WorkflowNotFoundError)) throw e;
      }
      return { created: false, channelId: token };
    }
    // `created` is informational (the route surfaces it). A channel "exists" only if a RUNNING run
    // holds the token — a COMPLETED one (post-__close) is retained in history but signalWithStart will
    // start a FRESH run, so that counts as created. NotFound likewise. (Benign race on the flag only.)
    let existed = false;
    try {
      const desc = await client.workflow.getHandle(token).describe();
      existed = desc.status.name === "RUNNING";
    } catch (e) {
      if (!(e instanceof WorkflowNotFoundError)) throw e;
    }
    await client.workflow.signalWithStart(WORKFLOW_TYPE, {
      taskQueue: this.#cfg.taskQueue,
      workflowId: token,
      args: [token],
      signal: PUBLISH_SIGNAL,
      signalArgs: [payload],
    });
    return { created: !existed, channelId: token };
  }

  async subscribe(
    token: string,
    startIndex: number | undefined,
  ): Promise<ReadableStream<WireFrame> | null> {
    const client = await this.#client_();
    const handle = client.workflow.getHandle(token);

    // Resolve-or-null: an absent workflow → null (the route replies 200-empty). The first query also
    // gives us the total, needed to resolve a negative (recent-window) startIndex.
    let initial: RelayState;
    try {
      initial = await handle.query<RelayState, [number]>(STATE_QUERY, 0);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return null;
      throw e;
    }

    // undefined → 0; negative → recent window (last |n|); positive → absolute, clamped to [0, total].
    let cursor = 0;
    if (startIndex !== undefined) {
      cursor =
        startIndex < 0
          ? Math.max(0, initial.total + startIndex)
          : Math.min(startIndex, initial.total);
    }

    let stopped = false;
    return new ReadableStream<WireFrame>({
      pull: async (controller) => {
        // Poll until at least one frame is available from the cursor, or the channel has closed.
        while (!stopped) {
          let st: RelayState;
          try {
            st = await handle.query<RelayState, [number]>(STATE_QUERY, cursor);
          } catch (e) {
            // The run vanished (terminated/expired) — end the stream rather than spin.
            if (e instanceof WorkflowNotFoundError) {
              controller.close();
              return;
            }
            throw e;
          }
          if (st.frames.length > 0) {
            for (const f of st.frames) controller.enqueue(f as WireFrame);
            cursor += st.frames.length;
            return;
          }
          if (st.closed) {
            controller.close();
            return;
          }
          await new Promise((r) => setTimeout(r, this.#pollMs));
        }
        controller.close();
      },
      cancel: () => {
        stopped = true;
      },
    });
  }
}
