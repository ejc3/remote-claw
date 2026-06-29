// The browser viewer: a thin, framework-free wrapper over the SHARED transport (@remote-claw/cli/broker)
// for the things a phone/laptop driver does — discover sessions on the bus, tail a session's
// transcript, ask for history, and send a prompt. It reuses the exact BrokerClient / FrameOrderer /
// SecurityProvider the host uses, so there is no second protocol implementation to drift.

import { type FrameHeader, type Identity, parsePass, utf8 } from "@remote-claw/clawsec";
import {
  BrokerClient,
  type BrokerClientOptions,
  FrameOrderer,
  securityProvider,
} from "@remote-claw/cli/broker";

const td = new TextDecoder();

/** Freshness bound for control verbs (§3.7) — a verb the broker withholds past it is a no-op, so it
 *  can't replay a stale interrupt/set_mode/end. NOTE: this is deliberately NOT the disconnect threshold
 *  anymore (that's the connState ladder below) — widening "disconnected" must not widen the replay
 *  window for control verbs, so the two are decoupled. */
export const FRESH_WINDOW_MS = 60_000;

/** A still-CONNECTED announce is at most this old. The host re-announces every ~20s + immediately on
 *  any phase/needs change (relay's ANNOUNCE_KEEPALIVE_MS), so a healthy session stays well under this;
 *  crossing it means ≥2 keepalives were missed → we're RECONNECTING, not yet declared gone (#58). */
export const CONNECTED_WINDOW_MS = 45_000;

/** Once an announce goes stale we show RECONNECTING for this long before declaring the host gone — and
 *  the countdown RESTARTS on focus (see connState). Sized over the keepalive (~20s) + a stream
 *  re-subscribe so a tab returning from the background always gets a full window for a fresh announce to
 *  land before it reads as disconnected. Decoupled from FRESH_WINDOW_MS (the control-verb bound). */
export const RECONNECTING_WINDOW_MS = 30_000;
export const TRANSCRIPT_GAP_STALL_MS = 10_000;
const DURABILITY_PROBE_ATTEMPTS = 3;
const DURABILITY_PROBE_BASE_MS = 50;
const PARTIAL_CHUNK_STALL_MS = 250;

/** The viewer's view of the host link, derived from announce freshness (§4.3 / #58):
 *  connected (fresh) → reconnecting (stale, within grace) → disconnected (grace elapsed). */
export type ConnState = "connected" | "reconnecting" | "disconnected";

/**
 * Classify the host link. `now` is passed in (not read here) so the UI owns the clock/ticks.
 *
 * The transition ALWAYS passes through "reconnecting" for a full {@link RECONNECTING_WINDOW_MS} before
 * "disconnected". `reconnectingSince` is when the CURRENT reconnect attempt began — tracked per session
 * by the UI via {@link nextReconnectAnchor}: it is set ONCE when an announce first reads stale (after a
 * backgrounded tab returns, that's the moment of return) and is NOT reset by repeated focus. So a tab
 * returning from the background shows "reconnecting" for a full window (while the re-subscribed stream
 * pulls a fresh announce) instead of snapping to "disconnected" — yet a genuinely-dead host still reaches
 * "disconnected" after one window and STAYS there even if the user keeps unlocking/app-switching back
 * (sub-window focus must not hold a dead session alive forever). `reconnectingSince` defaults to 0:
 * callers that don't track it get the plain stale→reconnecting→disconnected ladder anchored at staleAt.
 */
export function connState(sentAt: number, now: number, reconnectingSince = 0): ConnState {
  if (now - sentAt < CONNECTED_WINDOW_MS) return "connected";
  const anchor = reconnectingSince > 0 ? reconnectingSince : sentAt + CONNECTED_WINDOW_MS;
  if (now - anchor < RECONNECTING_WINDOW_MS) return "reconnecting";
  return "disconnected";
}

/**
 * Advance a session's reconnect-attempt anchor. Set ONCE when an announce first reads stale, held until
 * the session is connected again (then cleared). Crucially it is NOT reset while it stays stale, so
 * repeated focus can't hold a dead host at "reconnecting" forever — on a phone, unlocking/app-switching
 * back is the normal sub-window interaction, and re-anchoring on each would make "disconnected"
 * unreachable. `now` is the anchor when newly stale (after a return-from-background, that's the return
 * instant, giving a full grace window for the re-subscribe to pull a fresh announce).
 */
export function nextReconnectAnchor(
  prev: number | undefined,
  stale: boolean,
  now: number,
): number | undefined {
  if (!stale) return undefined;
  return prev ?? now;
}

/** What to show in an EMPTY transcript, distinguished by the host link (`cs`) so a live-but-idle session
 *  (connected, no turns yet) reads as "ready for a prompt" — NOT the ambiguous "waiting for the
 *  transcript…", which implies content is still arriving. `null` = no announce seen yet (connecting). */
export function emptyTranscriptHint(cs: ConnState | null): string {
  switch (cs) {
    case "connected":
      return "No messages yet — send a prompt to start.";
    case "reconnecting":
      return "Reconnecting to the session…";
    case "disconnected":
      // Neutral: a disconnected host MIGHT reconnect, but a wrong/stale pass or a host that exited never
      // will — so don't promise a reconnect we can't guarantee (the old "waiting for it to reconnect" read
      // as "it's coming back", leaving a dead/stale session looking perpetually hopeful).
      return "The host is offline — it may reconnect, or the session has ended.";
    default:
      return "Connecting…"; // no announce yet — we haven't reached the session
  }
}

/** Accessible name for the connection-state dot, so the state isn't conveyed by color alone (a11y).
 *  Lives beside connState/emptyTranscriptHint so a future ConnState is labeled here in one place. */
export function connStateLabel(cs: ConnState): string {
  switch (cs) {
    case "connected":
      return "online";
    case "reconnecting":
      return "reconnecting";
    case "disconnected":
      return "offline";
  }
}

/** Presence replay rule: keep the newest announce per session. Equal timestamps are accepted so a
 *  same-millisecond mode/status update from the host can replace the previous body. */
export function shouldAcceptAnnounce(existing: Announce | undefined, incoming: Announce): boolean {
  return existing === undefined || incoming.sentAt >= existing.sentAt;
}

function parseIncarnation(body: Record<string, unknown>): string | null {
  const raw = body.incarnation ?? body.launch_incarnation;
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

/** The session's git state, snapshotted by the host at announce time (#49). null outside a repo. */
export interface GitInfo {
  branch: string;
  sha: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

/** A decrypted session_announce from the bus. `status`/`phase`/`needs` are the live presence the host
 *  folds onto every (re-)announce (#48/#58); absent on a pre-presence host, so they default benignly
 *  (status "", phase idle, needs false) — an old host simply shows no thinking/needs indicator. */
export interface Announce {
  sessionId: string;
  title: string;
  cwd: string | null;
  sentAt: number;
  /** Per relay-process launch id. A change means non-durable transcript seq may have restarted at 0. */
  incarnation: string | null;
  /** Raw worker_status (idle/running/requires_action/…) — kept verbatim for display/debug. */
  status: string;
  /** Derived activity: "thinking" = actively generating, "idle" = not. Drives the working indicator. */
  phase: "idle" | "thinking";
  /** The worker is waiting on the human (an open permission gate or requires_action). */
  needs: boolean;
  /** Current worker permission mode, when announced by a modern host. Old hosts omit it. */
  mode?: string;
  /** The session's git snapshot for the branch/dirty/ahead-behind chip (#49); null outside a repo. */
  git: GitInfo | null;
  /** What the host's driver can faithfully service (#149). Absent on a pre-capability host → the viewer
   *  assumes full capability (a legacy host is always the MITM driver), so nothing gets disabled. */
  capabilities?: Capabilities;
}

/** Per-verb control support a driver declares (mirrors the host's ControlCapabilities). The viewer
 *  disables + labels the controls a driver can't honor, so a permission-mode/model "✓" never lies. */
export interface ControlCaps {
  interrupt: boolean;
  setModel: boolean;
  setMode: boolean;
  end: boolean;
}

/** Driver capabilities as carried on session_announce (mirrors the host's DriverCapabilities). */
export interface Capabilities {
  structuredPermissions: boolean;
  status: boolean;
  controls: ControlCaps;
  attachments: boolean;
}

/** Defensively coerce an announce's `capabilities` into Capabilities|undefined. Decrypted-but-untrusted
 *  (AEAD proves the host wrote it, not that it's well-formed), so every field is type-checked. A missing
 *  or malformed body returns undefined → the viewer treats the host as fully capable (no false gating of
 *  a legacy MITM host). Each control defaults to ENABLED when absent, for the same don't-over-gate reason;
 *  a driver that can't honor a verb states `false` explicitly. */
export function parseCapabilities(raw: unknown): Capabilities | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const ctlRaw =
    typeof c.controls === "object" && c.controls !== null
      ? (c.controls as Record<string, unknown>)
      : {};
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
  return {
    structuredPermissions: bool(c.structuredPermissions, true),
    status: bool(c.status, true),
    controls: {
      interrupt: bool(ctlRaw.interrupt, true),
      setModel: bool(ctlRaw.setModel, true),
      setMode: bool(ctlRaw.setMode, true),
      end: bool(ctlRaw.end, true),
    },
    attachments: bool(c.attachments, true),
  };
}

/** Defensively coerce an announce's `git` field into GitInfo|null. The body is decrypted-but-untrusted
 *  (a malicious broker can't forge it past AEAD, but a malformed host could), so every field is type-
 *  checked and a non-object (or a missing branch) collapses to null — no chip rather than a crash. */
export function parseGit(raw: unknown): GitInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.branch !== "string" || g.branch === "") return null;
  return {
    branch: g.branch,
    sha: typeof g.sha === "string" ? g.sha : "",
    dirty: g.dirty === true,
    ahead: typeof g.ahead === "number" && Number.isFinite(g.ahead) ? g.ahead : 0,
    behind: typeof g.behind === "number" && Number.isFinite(g.behind) ? g.behind : 0,
  };
}

/** A decrypted transcript message from a session's out-stream. */
export interface Message {
  kind: string;
  seq: number | null;
  text: string;
  msgId: string;
  /** Set on a locally-rendered OPTIMISTIC echo (#113): the user's own just-sent message, shown instantly
   *  (msgId `pending-<clientMsgId>`) before the host echoes it back. The `accepted` ack (matching
   *  clientMsgId) re-keys it to the real `user-<seq>` so the host's content echo dedups — no flash, no dup. */
  clientMsgId?: string;
  optimistic?: boolean;
  /** Present only on kind:"gap": the first seq the orderer is still waiting for. */
  nextSeq?: number;
  /** Present only on kind:"gap": buffered content entries blocked behind that missing seq. */
  pending?: number;
  /** Present only on kind:"gap": when this missing-seq stall was first observed. */
  since?: number;
}

export class Viewer {
  readonly #client: BrokerClient;
  readonly #identityId: Uint8Array;
  readonly #incarnations = new Map<string, string>();
  readonly #incarnationListeners = new Map<string, Set<(incarnation: string) => void>>();
  readonly #durability = new Map<string, boolean>();

  private constructor(
    identity: Identity,
    baseUrl: string,
    fetchFn?: typeof fetch,
    backend?: string,
  ) {
    this.#identityId = identity.identityId;
    const opts: BrokerClientOptions = {
      baseUrl,
      provider: securityProvider("sealed", identity),
    };
    // exactOptionalPropertyTypes: only set optional fields when actually supplied.
    if (fetchFn !== undefined) opts.fetchFn = fetchFn;
    if (backend !== undefined && backend !== "") opts.backend = backend;
    this.#client = new BrokerClient(opts);
  }

  /**
   * Build a viewer from a pasted/fragment pass (`rcp1_…`). Throws PassError on a bad pass. `baseUrl`
   * defaults to same-origin (""); `fetchFn` is for tests; `backend` selects the broker backend
   * ("sqlite" etc.) for this viewer's calls (sent as the x-broker-backend header).
   */
  static async fromPass(
    pass: string,
    baseUrl = "",
    fetchFn?: typeof fetch,
    backend?: string,
  ): Promise<Viewer> {
    return new Viewer(await parsePass(pass.trim()), baseUrl, fetchFn, backend);
  }

  #header(
    extra: Partial<FrameHeader> & Pick<FrameHeader, "recordKind" | "sessionId" | "msgId">,
  ): FrameHeader {
    return {
      v: 1,
      identityId: this.#identityId,
      dir: "in",
      seq: null,
      keyEpoch: 0,
      part: 0,
      parts: 1,
      ...extra,
    };
  }

  #rememberIncarnation(sessionId: string, incarnation: string | null): void {
    if (incarnation === null) return;
    const prev = this.#incarnations.get(sessionId);
    if (prev === undefined) {
      this.#incarnations.set(sessionId, incarnation);
      return;
    }
    if (prev === incarnation) return;
    this.#incarnations.set(sessionId, incarnation);
    const listeners = this.#incarnationListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const fn of listeners) fn(incarnation);
  }

  #onIncarnationChange(sessionId: string, fn: (incarnation: string) => void): () => void {
    let listeners = this.#incarnationListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#incarnationListeners.set(sessionId, listeners);
    }
    listeners.add(fn);
    return () => {
      listeners?.delete(fn);
      if (listeners?.size === 0) this.#incarnationListeners.delete(sessionId);
    };
  }

  async #durable(sessionId: string, fallback?: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < DURABILITY_PROBE_ATTEMPTS; attempt++) {
      try {
        const durable = (await this.#client.seqCursor(sessionId)).durable;
        this.#durability.set(sessionId, durable);
        return durable;
      } catch {
        if (attempt < DURABILITY_PROBE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, DURABILITY_PROBE_BASE_MS * 2 ** attempt));
        }
      }
    }
    return fallback ?? this.#durability.get(sessionId) ?? true;
  }

  /**
   * Tail the identity bus; yield each fresh session_announce (decrypted under K_meta). Re-subscribes
   * when the stream ends: the bus run may not exist yet (you opened the app before any host
   * announced) or may have cap-rolled. Consumers key presence by session_id + sent_at, so a
   * re-yielded announce across a reconnect is harmless. Loops until `signal` aborts.
   *
   * `onError` reports the bus transport's health so a SUSTAINED outage becomes observable instead of a
   * silent retry-forever: it's called with the error when a subscribe/stream throws (broker down, a
   * wrong/stale pass that can't reach the bus, a 5xx), and with `null` the moment the transport is back
   * up — a frame streamed, or the stream drained cleanly (the run just doesn't exist yet). Discovery
   * itself NEVER ends on an error; it always falls through to the retry. The caller debounces (a single
   * SSE blip clears on the next subscribe; only a persistent failure should surface to the user).
   */
  async *announces(
    signal: AbortSignal,
    onError?: (err: unknown) => void,
  ): AsyncGenerator<Announce> {
    while (!signal.aborted) {
      try {
        let up = false;
        for await (const frame of this.#client.streamFrames({ startIndex: -64, signal })) {
          if (!up) {
            up = true;
            onError?.(null); // a frame streamed → transport is up → clear any prior outage
          }
          if (frame.recordKind !== "session_announce") continue;
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(td.decode(await this.#client.openFrame(frame)));
          } catch {
            continue; // a frame we can't open/parse (not ours / corrupt) — skip, never crash the list
          }
          const sessionId = String(body.session_id ?? frame.sessionId);
          const announce: Announce = {
            sessionId,
            title: typeof body.title === "string" ? body.title : String(body.session_id ?? ""),
            cwd: typeof body.cwd === "string" ? body.cwd : null,
            sentAt: typeof body.sent_at === "number" ? body.sent_at : 0,
            incarnation: parseIncarnation(body),
            // Presence fields (#48/#58). Pre-presence hosts omit them → benign defaults.
            status: typeof body.status === "string" ? body.status : "",
            phase: body.phase === "thinking" ? "thinking" : "idle",
            needs: body.needs === true,
            git: parseGit(body.git), // git chip (#49); null outside a repo / on an old host
          };
          if (typeof body.mode === "string" && body.mode !== "") announce.mode = body.mode;
          const caps = parseCapabilities(body.capabilities); // driver capabilities (#149); undefined on legacy hosts
          if (caps) announce.capabilities = caps;
          this.#rememberIncarnation(sessionId, announce.incarnation);
          yield announce;
        }
        onError?.(null); // stream drained cleanly (run not up yet / cap-rolled) → broker still reachable
      } catch (e) {
        // A transient stream error (network blip / SSE reset / broker 5xx) must NOT end discovery — fall
        // through to the resume-or-retry sleep and re-subscribe, exactly like the relay does. But REPORT it
        // so the UI can debounce a SUSTAINED outage into a visible "can't reach the broker" signal rather
        // than spinning forever in silence.
        onError?.(e);
      }
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, 150)); // bus run not up / stream closed → resume-or-retry
    }
  }

  /**
   * Tail a session's out-stream; yield decoded transcript messages (deduped + reordered by seq).
   * Re-subscribes when the stream ends: the session run may not exist yet (you opened the session
   * before the host posted anything) or may have cap-rolled (the "window rolling over"). The
   * FrameOrderer persists across re-subscribes; for CONTENT frames its seq cursor (drops seq < next)
   * is what guarantees no gap and no duplicate on the re-read — the bounded msg_id window only de-dups
   * the seq===null meta frames (e.g. `accepted`), which are idempotent to re-yield (rendered as
   * nothing) even if the window evicts on a very long session. Loops until `signal` aborts.
   */
  async *transcript(sessionId: string, signal: AbortSignal): AsyncGenerator<Message> {
    let orderer = new FrameOrderer();
    let streamMode: "full" | "tail" = "full";
    let durable: boolean | undefined;
    let catchUpOnSubscribe = false;
    let streamCursor = 0;
    let gap: {
      nextSeq: number;
      pending: number;
      since: number;
      reported: string;
      partial: boolean;
    } | null = null;

    const restarts: string[] = [];
    let restartResolve: ((incarnation: string) => void) | null = null;
    const nextRestart = () => {
      const queued = restarts.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve) => {
        restartResolve = resolve;
      });
    };
    const stopIncarnationWatch = this.#onIncarnationChange(sessionId, (incarnation) => {
      if (restartResolve === null) {
        restarts.push(incarnation);
      } else {
        restartResolve(incarnation);
        restartResolve = null;
      }
    });

    let restartPromise = nextRestart();
    const gapSignal = (): Message | null => {
      // Surface both genuinely missing seqs and an incomplete chunked message at the cursor. The latter
      // should be transient, but if a later chunk failed after earlier chunks landed this is the only
      // bounded recovery signal instead of a silent permanent stall.
      const partial = orderer.stalledOnIncompleteSeq;
      if (!orderer.stalledOnMissingSeq && !partial) return null;
      if (gap === null || gap.nextSeq !== orderer.nextSeq || gap.partial !== partial) {
        gap = {
          nextSeq: orderer.nextSeq,
          pending: orderer.pending,
          since: Date.now(),
          reported: "",
          partial,
        };
      } else {
        gap.pending = orderer.pending;
      }
      if (gap.partial && Date.now() - gap.since < PARTIAL_CHUNK_STALL_MS) return null;
      const reportKey = `${gap.nextSeq}:${gap.pending}:${gap.partial ? "partial" : "missing"}`;
      if (gap.reported === reportKey) return null;
      gap.reported = reportKey;
      return {
        kind: "gap",
        seq: null,
        text: "",
        msgId: `gap-${sessionId}-${gap.nextSeq}-${gap.since}`,
        nextSeq: gap.nextSeq,
        pending: gap.pending,
        since: gap.since,
      };
    };
    const partialGapTimer = (): Promise<{ type: "gap_timer" }> | null => {
      if (gap === null || !gap.partial || gap.reported !== "") return null;
      const delay = Math.max(0, gap.since + PARTIAL_CHUNK_STALL_MS - Date.now());
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: "gap_timer" }), delay);
        if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
      });
    };

    try {
      while (!signal.aborted) {
        // Re-read from the start of the run unless this is a non-durable incarnation. In tail mode the
        // host's catch_up replay supplies the current incarnation's log after the live subscription is up.
        const startIndex = streamMode === "tail" ? streamCursor : 0;
        let cursor = startIndex;
        try {
          const frames = this.#client.streamFrames({
            session: sessionId,
            startIndex,
            signal,
          });
          const iter = frames[Symbol.asyncIterator]();
          let nextFrame = iter.next().then(
            (res) => ({ type: "frame" as const, res }),
            (error) => ({ type: "error" as const, error }),
          );
          if (catchUpOnSubscribe) {
            catchUpOnSubscribe = false;
            void this.requestHistory(sessionId, 0).catch(() => {});
          }
          for (;;) {
            const timer = partialGapTimer();
            const event = await Promise.race([
              nextFrame,
              restartPromise.then(() => ({ type: "restart" as const })),
              ...(timer === null ? [] : [timer]),
            ]);
            if (event.type === "gap_timer") {
              const stalled = gapSignal();
              if (stalled !== null) yield stalled;
              continue;
            }
            if (event.type === "restart") {
              await iter.return?.(undefined);
              restartPromise = nextRestart();
              durable = await this.#durable(sessionId, durable);
              if (durable) {
                streamMode = "full";
              } else {
                orderer = new FrameOrderer();
                streamMode = "tail";
                catchUpOnSubscribe = true;
                gap = null;
              }
              break;
            }
            if (event.type === "error") throw event.error;
            if (event.res.done === true) {
              const stalled = gapSignal();
              if (stalled !== null) yield stalled;
              break;
            }
            const frame = event.res.value;
            cursor += 1;
            streamCursor = Math.max(streamCursor, cursor);
            nextFrame = iter.next().then(
              (res) => ({ type: "frame" as const, res }),
              (error) => ({ type: "error" as const, error }),
            );
            if (frame.dir !== "out") continue; // the viewer renders host→web frames only
            // The orderer releases a chunked message (parts > 1) as its parts together, in part order — so
            // reassemble those with openMessage; a single frame opens directly.
            const ready = orderer.accept(frame);
            if (ready.length === 0) {
              const stalled = gapSignal();
              if (stalled !== null) yield stalled;
              continue;
            }
            if (ready.some((f) => f.seq !== null)) gap = null;
            for (let i = 0; i < ready.length; ) {
              const f = ready[i];
              if (f === undefined) break;
              const span = f.parts > 1 ? f.parts : 1;
              const group = ready.slice(i, i + span);
              i += span;
              let text: string;
              try {
                text = td.decode(
                  span > 1
                    ? await this.#client.openMessage(group)
                    : await this.#client.openFrame(f),
                );
              } catch {
                continue; // a frame/message we can't open (not ours / corrupt) — skip, never crash the list
              }
              yield { kind: f.recordKind, seq: f.seq, text, msgId: f.msgId };
            }
          }
        } catch {
          // A transient stream error must NOT end the transcript — fall through to resume-or-retry and
          // re-subscribe. The persistent FrameOrderer makes the re-read idempotent (no gap, no dup).
        }
        if (signal.aborted) break;
        await new Promise((r) => setTimeout(r, 150)); // run not up / stream closed → resume-or-retry
      }
    } finally {
      stopIncarnationWatch();
    }
  }

  /** Ask the host to replay history from `since` (a control frame on the session channel). */
  async requestHistory(sessionId: string, since = 0): Promise<void> {
    await this.#client.postFrame(
      this.#header({ recordKind: "catch_up", sessionId, msgId: `catchup-${since}-${randomId()}` }),
      utf8(JSON.stringify({ since, expiry: Date.now() + FRESH_WINDOW_MS })),
    );
  }

  /**
   * Grant or deny a worker `can_use_tool` request (a `permission` control frame, dir:in). The host
   * answers the worker's control_request with the chosen behavior. `requestId` comes from the
   * `permission_request` transcript frame the host relayed. For an AskUserQuestion (#42), pass
   * `extra.answers` ({question→choice}) + `extra.toolUseId` so the host builds the real
   * `updatedInput.answers` + `toolUseID` shape claude expects.
   */
  async grantPermission(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny" = "allow",
    extra?: { answers?: Record<string, string | string[]>; toolUseId?: string },
  ): Promise<void> {
    // An empty request_id can't match any worker control_request — never seal a useless frame.
    if (requestId === "") throw new Error("grantPermission: empty requestId");
    const body: Record<string, unknown> = { request_id: requestId, behavior };
    if (extra?.answers) body.answers = extra.answers;
    if (extra?.toolUseId) body.tool_use_id = extra.toolUseId;
    await this.#client.postFrame(
      this.#header({
        recordKind: "permission",
        sessionId,
        msgId: `perm-${requestId}-${randomId()}`,
      }),
      utf8(JSON.stringify(body)),
    );
  }

  /** Post a control-verb frame (dir:in) the host forwards to the worker as a control_request (§3.7).
   *  Stamps `expiry` so a control action the broker withholds and replays later is dropped as stale. */
  async #control(
    sessionId: string,
    kind: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#client.postFrame(
      this.#header({ recordKind: kind, sessionId, msgId: `${kind}-${randomId()}` }),
      utf8(JSON.stringify({ ...body, expiry: Date.now() + FRESH_WINDOW_MS })),
    );
  }

  /** Interrupt the current turn (the remote ESC). */
  async interrupt(sessionId: string): Promise<void> {
    await this.#control(sessionId, "interrupt");
  }

  /** Switch the session's model mid-flight (e.g. "claude-opus-4-8"). */
  async setModel(sessionId: string, model: string): Promise<void> {
    await this.#control(sessionId, "set_model", { model });
  }

  /** Change the permission mode (default | acceptEdits | plan | bypassPermissions | …). */
  async setMode(sessionId: string, mode: string): Promise<void> {
    await this.#control(sessionId, "set_mode", { mode });
  }

  /** End the session from the remote. */
  async endSession(sessionId: string): Promise<void> {
    await this.#control(sessionId, "end");
  }

  /** Run a slash command (`/compact`, `/clear`, `/context`, …). claude processes it as input, so it
   *  rides the SAME `user` path as a prompt — acked + echoed to every device, replayable via catch_up
   *  (a control frame would skip all three). Returns its client_msg_id. */
  async command(sessionId: string, text: string): Promise<string> {
    return this.sendPrompt(sessionId, text);
  }

  /** Send a prompt to the session (a `user` content frame, dir:in). Returns its client_msg_id. An
   *  explicit `clientMsgId` lets the caller render an optimistic echo first and reconcile on the host's
   *  `accepted` ack (#113); omitted ⇒ a fresh one. */
  async sendPrompt(
    sessionId: string,
    text: string,
    clientMsgId = `c-${randomId()}`,
  ): Promise<string> {
    await this.#client.postFrame(
      this.#header({ recordKind: "user", sessionId, msgId: clientMsgId, clientMsgId }),
      utf8(text),
    );
    return clientMsgId;
  }

  /**
   * Send a grouped file/photo attachment (#44/#114): ONE `attachment` message (dir:in) carrying all the
   * images of a single send + one caption, E2E-sealed so the broker never sees the bytes. Sent via
   * `postMessage`, which splits a large payload into ≤3 MB AEAD chunk frames sharing one `msgId` — so a
   * big or multi-image send is NOT blocked by Vercel's ~4.5 MB body cap (the host reassembles them). The
   * host writes every image and drives claude with ONE prompt (`@"p1" @"p2" caption`), so the caption
   * rides once. `data` is base64 (no data-URI prefix). Returns the message's `msgId`.
   */
  async sendAttachment(
    sessionId: string,
    att: { images: { name: string; mime: string; data: string }[]; caption?: string },
    clientMsgId = `att-${randomId()}`,
  ): Promise<string> {
    const msgId = clientMsgId;
    const payload = utf8(JSON.stringify({ images: att.images, caption: att.caption ?? "" }));
    // Chunking handles the per-frame ~4.5 MB body cap, but still bound the TOTAL so a pathological send
    // can't stream unbounded bytes at the host (it caps reassembly at MAX_ATTACHMENT_PARTS too). Surfaced
    // as a clear, typed error rather than the platform's opaque "Load failed".
    if (payload.length > MAX_ATTACHMENT_TOTAL_BYTES)
      throw new AttachmentTooLargeError(payload.length);
    await this.#client.postMessage(
      this.#header({ recordKind: "attachment", sessionId, msgId, clientMsgId: msgId }),
      payload,
    );
    return msgId;
  }
}

/** Plaintext cap for a whole grouped attachment message (#114). Generous because `postMessage` chunks it
 *  across ≤3 MB frames under Vercel's body cap; this only bounds total bytes per send (the host also caps
 *  reassembly at MAX_ATTACHMENT_PARTS × chunk size). */
export const MAX_ATTACHMENT_TOTAL_BYTES = 48 * 1024 * 1024;

/** Thrown by sendAttachment when a send would exceed {@link MAX_ATTACHMENT_TOTAL_BYTES} — surfaced to
 *  the user as a clear "too large" rather than the platform's opaque "Load failed". */
export class AttachmentTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`attachment too large (${size} bytes; max ${MAX_ATTACHMENT_TOTAL_BYTES})`);
    this.name = "AttachmentTooLargeError";
  }
}

/** A short random id (browser + Node 22 both expose WebCrypto). */
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join("");
}
