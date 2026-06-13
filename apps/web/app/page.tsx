"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  basename,
  diffOf,
  dirname,
  editStat,
  isSlashCommand,
  parsePermissionResolved,
  parseQuestions,
  parseTask,
  parseToolResult,
  parseToolUse,
  type Question,
  sanitizeInput,
  type ToolInput,
  toolHint,
} from "./lib/transcript";
import {
  type Announce,
  type ConnState,
  connState,
  emptyTranscriptHint,
  type GitInfo,
  type Message,
  shouldAcceptAnnounce,
  TRANSCRIPT_GAP_STALL_MS,
  Viewer,
} from "./lib/viewer";

export interface TranscriptGap {
  nextSeq: number;
  pending: number;
  since: number;
}

export function shouldShowGapRecovery(gap: TranscriptGap | null, now: number): boolean {
  return gap !== null && now - gap.since >= TRANSCRIPT_GAP_STALL_MS;
}

function isGapMessage(
  m: Message,
): m is Message & Required<Pick<Message, "nextSeq" | "pending" | "since">> {
  return (
    m.kind === "gap" &&
    typeof m.nextSeq === "number" &&
    typeof m.pending === "number" &&
    typeof m.since === "number"
  );
}

function appendUniqueMessage(prev: Message[], msg: Message): Message[] {
  if (prev.some((m) => m.msgId === msg.msgId)) return prev;
  return [...prev, msg];
}

export default function Home() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [passInput, setPassInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // A pass may arrive in the URL fragment (#rcp1_…) — never sent to the server. Prefill it, strip it
  // from the address bar so it doesn't linger in history, but KEEP it in sessionStorage so a refresh
  // restores it (tab-scoped: survives reload, cleared when the tab closes, never back in the URL).
  // On a refresh the fragment is already gone, so fall back to the stored pass.
  useEffect(() => {
    const frag = window.location.hash.replace(/^#/, "");
    if (frag.startsWith("rcp1_")) {
      setPassInput(frag);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } else {
      const saved = sessionStorage.getItem("rc-pass");
      if (saved?.startsWith("rcp1_")) setPassInput(saved);
    }
  }, []);

  const connect = useCallback(async (pass: string) => {
    setError(null);
    setConnecting(true);
    try {
      // `?backend=` (e.g. temporal) opts this session onto a non-default broker backend; the Viewer
      // forwards it as the x-broker-backend header on every broker call. Same-origin, default fetch.
      const backend = new URLSearchParams(window.location.search).get("backend") ?? undefined;
      setViewer(await Viewer.fromPass(pass, "", undefined, backend));
      // Persist only AFTER a successful connect (covers a pasted pass too) so a refresh reconnects
      // without re-pasting. It's a live credential, so sessionStorage (tab-scoped), not localStorage.
      sessionStorage.setItem("rc-pass", pass);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  if (viewer === null) {
    return (
      <Connect
        pass={passInput}
        setPass={setPassInput}
        connect={connect}
        connecting={connecting}
        error={error}
      />
    );
  }
  return (
    <Console
      viewer={viewer}
      onForget={() => {
        sessionStorage.removeItem("rc-pass"); // "Forget" must actually forget — drop the stored pass
        setViewer(null);
      }}
    />
  );
}

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">⌘</span>
      remote-claw
    </span>
  );
}

function Connect(props: {
  pass: string;
  setPass: (s: string) => void;
  connect: (s: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const disabled = props.connecting || props.pass.trim() === "";
  return (
    <main className="connect">
      <div className="connect-card">
        <Brand />
        <h1>Drive your claude, remotely.</h1>
        <p className="muted">
          Paste a machine <strong>pass</strong> to read and steer its claude sessions, end-to-end
          encrypted. The broker never sees your keys or your messages.
        </p>
        <textarea
          className="field"
          value={props.pass}
          onChange={(e) => props.setPass(e.target.value)}
          placeholder="rcp1_…"
          spellCheck={false}
          rows={3}
        />
        <button
          type="button"
          className="btn btn-block"
          disabled={disabled}
          onClick={() => props.connect(props.pass)}
        >
          {props.connecting ? "Connecting…" : "Connect"}
        </button>
        {props.error !== null && <p className="error">Couldn’t load that pass: {props.error}</p>}
        <p className="hint">
          Get a pass on the machine with <code>remote-claw --rc-pass</code>. A pass can read and
          steer that machine’s sessions but is not the master secret.
        </p>
      </div>
    </main>
  );
}

/** A coarse "N ago" label for a lapsed session (only shown once it reads as disconnected). */
function relativeTime(ms: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** The session row's sub-line word, combining connection state + activity (#48/#58): a connected
 *  session reads its phase/needs; a lapsing one reads its link state; a gone one reads "N ago". */
function presenceWord(s: Announce, now: number): string {
  const cs = connState(s.sentAt, now);
  if (cs === "disconnected") return relativeTime(s.sentAt, now);
  if (cs === "reconnecting") return "reconnecting…";
  if (s.needs) return "needs you";
  if (s.phase === "thinking") return "working…";
  return "online";
}

/** The session's git context (#49): branch, a dot for uncommitted changes, and ahead/behind vs its
 *  upstream (zeros omitted). A static snapshot from announce time — title carries the precise sha. */
function GitChip({ git }: { git: GitInfo }) {
  const title = [
    git.branch,
    git.sha ? `@ ${git.sha}` : "",
    git.dirty ? "· uncommitted changes" : "· clean",
    git.ahead || git.behind ? `· ↑${git.ahead} ↓${git.behind}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="git-chip" title={title}>
      <span className="git-branch">⎇ {git.branch}</span>
      {git.dirty && (
        <span
          className="git-dirty"
          role="img"
          aria-label="uncommitted changes"
          title="uncommitted changes"
        >
          ●
        </span>
      )}
      {git.ahead > 0 && <span className="git-ab">↑{git.ahead}</span>}
      {git.behind > 0 && <span className="git-ab git-behind">↓{git.behind}</span>}
    </span>
  );
}

/** Base64 of a Blob without a per-byte loop: FileReader yields a `data:<mime>;base64,<…>` URL we slice. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.onload = () => {
      const s = typeof reader.result === "string" ? reader.result : "";
      resolve(s.slice(s.indexOf(",") + 1)); // strip the "data:…;base64," prefix
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale an image File to a JPEG and return base64 (no `data:` prefix), small enough for one E2E
 * frame (#44). Browser-only (canvas). The host writes the bytes + has claude `Read` them for vision.
 * Steps quality down (then dimension) until the base64 fits `maxB64` so a noisy photo still rides one
 * frame instead of failing the single-frame inbound POST.
 */
async function downscaleToBase64(file: File, maxDim = 1536, maxB64 = 900_000): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    let dim = maxDim;
    let last = "";
    for (const quality of [0.85, 0.7, 0.55, 0.45, 0.4]) {
      const scale = Math.min(1, dim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob === null) throw new Error("image encode failed");
      last = await blobToBase64(blob);
      if (last.length <= maxB64) return last;
      dim = Math.round(dim * 0.7); // still too big — shrink the longest edge and re-encode
    }
    return last; // best effort after the steps; the host enforces its own hard cap
  } finally {
    bitmap.close();
  }
}

/** A tiny three-dot "working" pulse (CSS-animated) — the viewer's thinking indicator (#48). */
function Working() {
  return (
    <span className="working" role="img" aria-label="working">
      <span />
      <span />
      <span />
    </span>
  );
}

function Console(props: { viewer: Viewer; onForget: () => void }) {
  const { viewer } = props;
  const [sessions, setSessions] = useState<Map<string, Announce>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Tail the bus → live session list (keep the freshest sent_at per session: replay-safe presence).
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        for await (const a of viewer.announces(ac.signal)) {
          setSessions((prev) => {
            const next = new Map(prev);
            const existing = next.get(a.sessionId);
            if (shouldAcceptAnnounce(existing, a)) next.set(a.sessionId, a);
            return next;
          });
        }
      } catch (e) {
        if (!ac.signal.aborted) setStreamError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ac.abort();
  }, [viewer]);

  // Re-evaluate presence on a timer so rows grey out as announces lapse.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const list = [...sessions.values()].sort((a, b) => b.sentAt - a.sentAt);
  const current = selected !== null ? sessions.get(selected) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <span className="count">
          {list.length} session{list.length === 1 ? "" : "s"}
        </span>
        <button type="button" className="ghost" onClick={props.onForget}>
          Forget pass
        </button>
      </header>

      <div className="panes" data-view={selected === null ? "list" : "chat"}>
        <nav className="sessions">
          {list.length === 0 && (
            <p className="empty-pad">
              No live sessions yet. On a machine, run <code>claude --remote-control</code> through{" "}
              <code>remote-claw</code>.
            </p>
          )}
          {list.map((s) => {
            const cs = connState(s.sentAt, now);
            const connected = cs === "connected";
            return (
              <button
                type="button"
                key={s.sessionId}
                className="row"
                data-active={selected === s.sessionId}
                data-state={cs}
                onClick={() => setSelected(s.sessionId)}
              >
                <span className="row-top">
                  <span className="dot" data-state={cs} />
                  <span className="row-title">{s.title}</span>
                  {connected && s.needs ? (
                    <span className="needs-badge">needs you</span>
                  ) : connected && s.phase === "thinking" ? (
                    <Working />
                  ) : null}
                </span>
                <span className="row-sub">
                  {s.git && <GitChip git={s.git} />}
                  {presenceWord(s, now)}
                  {s.cwd !== null ? ` · ${s.cwd}` : ""}
                </span>
              </button>
            );
          })}
          {streamError !== null && <p className="send-err">{streamError}</p>}
        </nav>

        {selected === null ? (
          <section className="chat">
            <div className="empty">Pick a session to open its transcript.</div>
          </section>
        ) : (
          <Transcript
            key={selected}
            viewer={viewer}
            sessionId={selected}
            title={current?.title ?? selected}
            announce={current}
            now={now}
            onBack={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function Transcript(props: {
  viewer: Viewer;
  sessionId: string;
  title: string;
  announce: Announce | undefined;
  now: number;
  onBack: () => void;
}) {
  const { viewer, sessionId, announce, now } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [gap, setGap] = useState<TranscriptGap | null>(null);
  const [gapRetrying, setGapRetrying] = useState(false);
  const autoGapRetry = useRef<string | null>(null);

  // Live connection state from the freshest announce (null until one arrives — then never scary).
  // Thinking/needs are only meaningful while connected; a stale announce's phase says nothing.
  const cs = announce ? connState(announce.sentAt, now) : null;
  const connected = cs === "connected";
  const phase = connected ? (announce?.phase ?? "idle") : "idle";
  const needs = connected ? (announce?.needs ?? false) : false;

  // Resolved permissions, folded from the LOGGED permission_resolved frames (#56) — this is the source
  // of truth that survives a reload (PermissionRow's local optimistic decision does not). The host
  // replays these on catch_up, so a previously-answered request renders resolved, never re-prompting.
  const resolved = useMemo(() => {
    const m = new Map<string, "allow" | "deny">();
    for (const msg of messages) {
      if (msg.kind !== "permission_resolved") continue;
      const r = parsePermissionResolved(msg.text);
      if (r.requestId !== "") m.set(r.requestId, r.behavior);
    }
    return m;
  }, [messages]);
  // The host announces the worker's effective permission mode. A local click is only a transient
  // optimistic override; the next mode-bearing announce wins, including when another device changed it.
  const [optimisticMode, setOptimisticMode] = useState<string | null>(null);
  const [modeSheet, setModeSheet] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const announceMode = announce?.mode;
  const announceSentAt = announce?.sentAt;
  const displayedMode = displayedPermissionMode(announceMode, optimisticMode);

  useEffect(() => {
    if (announceMode !== undefined && announceSentAt !== undefined) setOptimisticMode(null);
  }, [announceMode, announceSentAt]);

  useEffect(() => {
    setMessages([]);
    setGap(null);
    autoGapRetry.current = null;
    const ac = new AbortController();
    void viewer.requestHistory(sessionId, 0).catch(() => {});
    (async () => {
      try {
        for await (const m of viewer.transcript(sessionId, ac.signal)) {
          if (isGapMessage(m)) {
            setGap({ nextSeq: m.nextSeq, pending: m.pending, since: m.since });
          } else {
            setGap(null);
            setMessages((prev) => appendUniqueMessage(prev, m));
          }
        }
      } catch {
        /* aborted on unmount / session switch */
      }
    })();
    return () => ac.abort();
  }, [viewer, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the latest on every message.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const retryGap = useCallback(async () => {
    if (gap === null) return;
    setGapRetrying(true);
    setSendError(null);
    try {
      await viewer.requestHistory(sessionId, gap.nextSeq);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setGapRetrying(false);
    }
  }, [gap, sessionId, viewer]);

  const showGapRecovery = shouldShowGapRecovery(gap, now);
  useEffect(() => {
    if (!showGapRecovery || gap === null) return;
    const key = `${gap.nextSeq}:${gap.since}`;
    if (autoGapRetry.current === key) return;
    autoGapRetry.current = key;
    void retryGap();
  }, [gap, retryGap, showGapRecovery]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (text === "") return;
    setSending(true);
    setSendError(null);
    try {
      await viewer.sendPrompt(sessionId, text);
      setInput("");
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [input, sessionId, viewer]);

  // Attach a photo/image (#44): downscale to fit one E2E frame, send it (the composer text rides as the
  // caption), and the host writes it + has claude Read it. The bytes never reach the broker in cleartext.
  const fileRef = useRef<HTMLInputElement | null>(null);
  const attach = useCallback(
    async (file: File) => {
      setSending(true);
      setSendError(null);
      try {
        const data = await downscaleToBase64(file);
        await viewer.sendAttachment(sessionId, {
          name: file.name,
          mime: "image/jpeg",
          data,
          caption: input.trim(),
        });
        setInput("");
      } catch (e) {
        setSendError(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [input, sessionId, viewer],
  );

  const chooseMode = useCallback(
    async (id: string) => {
      setModeSheet(false);
      setSendError(null);
      const prev = optimisticMode;
      setOptimisticMode(id); // optimistic — revert if the control frame can't be sent
      try {
        await viewer.setMode(sessionId, id);
      } catch (e) {
        // Only revert if no newer choice landed while we were awaiting — else we'd clobber it.
        setOptimisticMode((cur) => (cur === id ? prev : cur));
        setSendError(e instanceof Error ? e.message : String(e));
      }
    },
    [optimisticMode, sessionId, viewer],
  );

  // Answer a worker permission_request (§17.4): seal a `permission` frame the host turns into the
  // control_response. Bound to this session; PermissionRow owns the per-request pending/resolved state.
  // `extra` carries an AskUserQuestion's {answers, toolUseId} (#42); absent for a plain allow/deny.
  const grant = useCallback<GrantFn>(
    (requestId, behavior, extra) => viewer.grantPermission(sessionId, requestId, behavior, extra),
    [sessionId, viewer],
  );

  return (
    <section className="chat">
      <div className="chat-head">
        <button type="button" className="back" onClick={props.onBack}>
          ‹ Sessions
        </button>
        <span className="row-title">{props.title}</span>
        {announce?.git && <GitChip git={announce.git} />}
      </div>

      <div className="transcript">
        {showGapRecovery && gap !== null && (
          <GapRecovery gap={gap} retrying={gapRetrying} onRetry={() => void retryGap()} />
        )}
        {messages.length === 0 && !showGapRecovery && (
          <p className="empty-pad">{emptyTranscriptHint(cs)}</p>
        )}
        {messages.map((m) => (
          <Bubble key={`${m.msgId}:${m.seq}`} message={m} onGrant={grant} resolved={resolved} />
        ))}
        <div ref={endRef} />
      </div>

      <StatusStrip conn={cs} phase={phase} needs={needs} />
      {sendError !== null && <p className="send-err">Couldn’t send: {sendError}</p>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          className="mode-btn"
          aria-haspopup="dialog"
          aria-expanded={modeSheet}
          onClick={() => setModeSheet(true)}
          title="Permission mode"
        >
          <span className="mode-glyph">{modeGlyph(displayedMode)}</span>
          {modeLabel(displayedMode)}
        </button>
        <button
          type="button"
          className="attach-btn"
          title="Attach a photo"
          aria-label="Attach a photo"
          disabled={sending}
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void attach(f);
            e.target.value = ""; // allow re-picking the same file
          }}
        />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a prompt…"
          enterKeyHint="send"
        />
        <button type="submit" className="btn" disabled={sending || input.trim() === ""}>
          Send
        </button>
      </form>

      {modeSheet && (
        <ModeSheet
          current={displayedMode}
          onPick={(id) => void chooseMode(id)}
          onClose={() => setModeSheet(false)}
        />
      )}
    </section>
  );
}

function GapRecovery({
  gap,
  retrying,
  onRetry,
}: {
  gap: TranscriptGap;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="chat-status transcript-gap" data-state="reconnecting" role="alert">
      <span>
        Transcript out of sync — retrying… waiting for seq {gap.nextSeq} ({gap.pending} buffered)
      </span>
      <button type="button" className="gap-retry" disabled={retrying} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** A pinned status line above the composer (#48/#58): surfaces a connection problem
 *  (reconnecting/disconnected) or the worker's activity (working / needs you). Hidden when connected +
 *  idle so a quiet session stays uncluttered, and hidden when `conn` is null (no announce seen yet —
 *  we don't claim a state we don't know). */
function StatusStrip({
  conn,
  phase,
  needs,
}: {
  conn: ConnState | null;
  phase: "idle" | "thinking";
  needs: boolean;
}) {
  // role="alert" (assertive) for states that need attention now; role="status" (polite) for ambient
  // activity — so a screen reader announces the flip to disconnected / needs-you / working (#58 a11y).
  if (conn === "disconnected")
    return (
      <div className="chat-status" data-state="disconnected" role="alert">
        Host disconnected — the session may have ended.
      </div>
    );
  if (conn === "reconnecting")
    return (
      <div className="chat-status" data-state="reconnecting" role="status">
        Reconnecting to the host… <Working />
      </div>
    );
  if (conn === "connected" && needs)
    return (
      <div className="chat-status" data-state="needs" role="alert">
        🔔 Claude needs your input
      </div>
    );
  if (conn === "connected" && phase === "thinking")
    return (
      <div className="chat-status" data-state="thinking" role="status">
        Claude is working… <Working />
      </div>
    );
  return null;
}

// The three permission modes Claude Code exposes (IMG_1825 "Select mode"). `id` is the exact RC
// set_permission_mode value the relay forwards to the worker (§3.7) — VERIFIED by capturing the real
// iOS app through `--rc-trace`: Auto="auto", Code="default", Plan="plan" (NOT default/acceptEdits).
const MODES = [
  {
    id: "auto",
    label: "Auto",
    glyph: "⚡",
    desc: "Claude decides which actions need confirmation",
  },
  { id: "default", label: "Code", glyph: "⌨", desc: "Claude writes and edits code directly" },
  {
    id: "plan",
    label: "Plan",
    glyph: "◑",
    desc: "Claude explores code and presents a plan before making edits",
  },
] as const;

function modeLabel(id: string | null): string {
  return MODES.find((m) => m.id === id)?.label ?? "Mode";
}
function modeGlyph(id: string | null): string {
  return MODES.find((m) => m.id === id)?.glyph ?? "⚙";
}

export function displayedPermissionMode(
  announcedMode: string | undefined,
  optimisticMode: string | null,
): string | null {
  return optimisticMode ?? announcedMode ?? null;
}

/** Bottom sheet to pick the session's permission mode — mirrors Claude Code's "Select mode" sheet. */
function ModeSheet({
  current,
  onPick,
  onClose,
}: {
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // onClose is a fresh arrow each parent render; read it through a ref so the focus/scroll-lock
  // effect can run exactly once (on open) without re-stealing focus or re-saving the trigger.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Open-once: focus into the sheet + trap Tab + lock scroll; restore on close. onClose is read via
  // a ref, so this effect has no reactive deps and must not re-run on parent re-renders.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null; // the composer mode button
    const focusables = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    // Move focus into the sheet (the active row, else the first) so keyboard users land on the choices.
    (
      dialogRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? focusables()[0]
    )?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap Tab within the sheet so it can't reach the controls behind the scrim.
      const f = focusables();
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // lock background scroll while modal
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      trigger?.focus?.(); // restore focus to the mode button
    };
  }, []);

  // Scrim and sheet are siblings (not nested): the sheet's own buttons aren't illegally nested inside
  // another button. The scrim is mouse-only (tabIndex -1) — keyboard dismiss is Escape; role=dialog
  // sits on the content (.sheet), not the overlay.
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="sheet-scrim"
        aria-label="Close mode picker"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="sheet"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Select mode"
      >
        <div className="sheet-handle" />
        <div className="sheet-title">Select mode</div>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className="mode-row"
            data-active={m.id === current}
            aria-pressed={m.id === current}
            onClick={() => onPick(m.id)}
          >
            <span className="mode-row-glyph">{m.glyph}</span>
            <span className="mode-row-main">
              <span className="mode-row-label">{m.label}</span>
              <span className="mode-row-desc">{m.desc}</span>
            </span>
            {m.id === current && (
              <span className="mode-check" aria-hidden>
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// The transcript renders as an asymmetric document, not symmetric chat: USER turns are small
// right-aligned pills; ASSISTANT turns are full-width prose (no bubble). Tool calls are compact
// tappable rows that expand to a Command/Diff detail; sub-agents and thinking nest/recede. (Inspired
// by Claude Code's mobile UI — see the design spec.)
type GrantExtra = { answers?: Record<string, string | string[]>; toolUseId?: string };
type GrantFn = (requestId: string, behavior: "allow" | "deny", extra?: GrantExtra) => Promise<void>;

export function Bubble({
  message,
  onGrant,
  resolved,
}: {
  message: Message;
  onGrant: GrantFn;
  resolved: Map<string, "allow" | "deny">;
}) {
  switch (message.kind) {
    case "result":
      return <p className="turn-sep" aria-hidden />;
    case "user":
      // A slash command (/compact, /clear, /model …) is rendered as a distinct command chip, not a chat
      // pill — it rides the same `user` path but is an instruction to claude, not a message (#41).
      return isSlashCommand(message.text) ? (
        <div className="row-command">
          <span className="cmd-chip">
            <span className="cmd-glyph">⌘</span>
            {message.text.trim()}
          </span>
        </div>
      ) : (
        <div className="row-user">
          <div className="pill">{message.text}</div>
        </div>
      );
    case "assistant":
      return <Prose className="assistant" text={message.text} />;
    case "assistant_sub":
      return (
        <div className="sub-thread">
          <Prose className="assistant assistant-sub" text={message.text} />
        </div>
      );
    case "assistant_thinking":
    case "assistant_thinking_sub":
      return <ThinkingRow text={message.text} sub={message.kind === "assistant_thinking_sub"} />;
    case "tool_use":
      return <ToolRow text={message.text} />;
    case "tool_result":
      return <ToolResultRow text={message.text} />;
    case "task":
      return <TaskRow text={message.text} />;
    case "permission_request":
      return <PermissionRow text={message.text} onGrant={onGrant} resolved={resolved} />;
    default:
      // accepted acks + lifecycle frames are not rendered standalone; permission_resolved is folded
      // into its PermissionRow (via the `resolved` map), not shown as its own row.
      return null;
  }
}

/** A thinking block — collapsed, muted, recedes. A sub-agent's reasoning nests under its Task. */
function ThinkingRow({ text, sub }: { text: string; sub: boolean }) {
  return (
    <details className="thinking" data-sub={sub}>
      <summary>💭 {sub ? "sub-agent thinking" : "thought"}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

/**
 * A worker permission request (RC usually auto-executes, §17.4 — shown when it doesn't). Renders the
 * tool + a one-line hint and Allow / Deny buttons; the decision rides back as a `permission` frame
 * (onGrant → viewer.grantPermission). Once answered (or if a request_id is missing) the buttons lock.
 */
function PermissionRow({
  text,
  onGrant,
  resolved,
}: {
  text: string;
  onGrant: GrantFn;
  resolved: Map<string, "allow" | "deny">;
}) {
  const req = parsePermission(text);
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A synchronous re-entry guard: `busy` is async React state, so two clicks fired in the same tick
  // would both pass a `busy`-based check and send conflicting grants. The ref closes that window.
  const deciding = useRef(false);

  // The host-logged resolution (replayed on catch_up) is the source of truth that survives a reload,
  // so it WINS over the local optimistic `decision`. On a fresh load `decision` is null but `confirmed`
  // is set → the row renders resolved instead of re-prompting with live buttons (#56/#57).
  const confirmed = resolved.get(req.requestId) ?? null;
  const effective = confirmed ?? decision;

  const decide = useCallback(
    async (behavior: "allow" | "deny") => {
      if (req.requestId === "" || deciding.current) return;
      deciding.current = true;
      setBusy(true);
      setErr(null);
      try {
        await onGrant(req.requestId, behavior);
        setDecision(behavior); // resolved view replaces the buttons — no further clicks possible
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        deciding.current = false; // failed — let the user retry
      } finally {
        setBusy(false);
      }
    },
    [req.requestId, onGrant],
  );

  // An AskUserQuestion is a can_use_tool whose input is multiple-choice questions — render the question
  // UI + answer with updatedInput.answers, not a bare Allow/Deny (#42). (Branch AFTER the hooks above
  // so the rules of hooks hold; QuestionCard owns its own state.)
  if (req.questions.length > 0) {
    return <QuestionCard req={req} onGrant={onGrant} resolved={resolved} />;
  }

  return (
    <div className="perm">
      <div className="perm-head">
        <span className="tool-glyph">🔐</span>
        <span className="perm-label">
          Allow <strong>{req.tool}</strong>?
        </span>
      </div>
      {req.hint !== "" && <div className="perm-hint">{req.hint}</div>}
      {effective === null ? (
        <div className="perm-actions">
          <button
            type="button"
            className="perm-btn perm-allow"
            disabled={busy || req.requestId === ""}
            onClick={() => void decide("allow")}
          >
            Allow
          </button>
          <button
            type="button"
            className="perm-btn perm-deny"
            disabled={busy || req.requestId === ""}
            onClick={() => void decide("deny")}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="perm-resolved" data-behavior={effective}>
          {effective === "allow" ? "✓ Allowed" : "✕ Denied"}
        </div>
      )}
      {req.requestId === "" && effective === null && (
        <div className="perm-hint">No request id — this prompt can’t be answered from here.</div>
      )}
      {err !== null && <div className="perm-err">Couldn’t send: {err}</div>}
    </div>
  );
}

interface ParsedPermission {
  tool: string;
  hint: string;
  requestId: string;
  toolUseId: string;
  questions: Question[];
}

/**
 * AskUserQuestion (#42): render each multiple-choice question + options; on submit, send the chosen
 * labels back as `updatedInput.answers` keyed by question text, with the request's `tool_use_id` — the
 * exact shape real claude expects (verified live via --rc-trace). Single-select picks one label;
 * multiSelect toggles an array. Survives reload via the host-logged `resolved` map (#56).
 */
function QuestionCard({
  req,
  onGrant,
  resolved,
}: {
  req: ParsedPermission;
  onGrant: GrantFn;
  resolved: Map<string, "allow" | "deny">;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const deciding = useRef(false);

  const done = resolved.get(req.requestId) != null || sent; // host-logged answer survives reload

  const pick = (q: Question, label: string) =>
    setAnswers((a) => {
      if (!q.multiSelect) return { ...a, [q.question]: label };
      const cur = Array.isArray(a[q.question]) ? (a[q.question] as string[]) : [];
      return {
        ...a,
        [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  const isPicked = (q: Question, label: string) => {
    const v = answers[q.question];
    return Array.isArray(v) ? v.includes(label) : v === label;
  };
  const answered = (q: Question) => {
    const v = answers[q.question];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string";
  };
  const allAnswered = req.questions.every(answered);

  const submit = useCallback(async () => {
    if (req.requestId === "" || deciding.current || !allAnswered) return;
    deciding.current = true;
    setBusy(true);
    setErr(null);
    try {
      await onGrant(req.requestId, "allow", { answers, toolUseId: req.toolUseId });
      setSent(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      deciding.current = false; // failed — let the user retry
    } finally {
      setBusy(false);
    }
  }, [req.requestId, req.toolUseId, answers, allAnswered, onGrant]);

  if (done) {
    return (
      <div className="perm perm-q">
        <div className="perm-resolved" data-behavior="allow">
          ✓ Answered
        </div>
      </div>
    );
  }

  return (
    <div className="perm perm-q">
      <div className="perm-head">
        <span className="tool-glyph">❓</span>
        <span className="perm-label">Claude is asking</span>
      </div>
      {req.questions.map((q) => (
        <div className="q-block" key={`${q.header}:${q.question}`}>
          {q.header !== "" && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className="q-option"
                data-selected={isPicked(q, o.label)}
                onClick={() => pick(q, o.label)}
              >
                <span className="q-option-label">{o.label}</span>
                {o.description !== "" && <span className="q-option-desc">{o.description}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="perm-btn perm-allow q-submit"
        disabled={busy || !allAnswered || req.requestId === ""}
        onClick={() => void submit()}
      >
        {busy ? "Sending…" : "Submit answers"}
      </button>
      {err !== null && <div className="perm-err">Couldn’t send: {err}</div>}
    </div>
  );
}

/** Parse a permission_request frame → tool, hint, request id, tool_use_id, and (for AskUserQuestion)
 *  the questions to render (#42). */
function parsePermission(text: string): ParsedPermission {
  try {
    const p = JSON.parse(text) as {
      request_id?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      tool_use_id?: unknown;
    };
    return {
      tool: typeof p.tool_name === "string" ? p.tool_name : "tool",
      hint: toolHint(sanitizeInput(p.tool_input)),
      requestId: typeof p.request_id === "string" ? p.request_id : "",
      toolUseId: typeof p.tool_use_id === "string" ? p.tool_use_id : "",
      questions: parseQuestions(p.tool_input),
    };
  } catch {
    return { tool: "tool", hint: "", requestId: "", toolUseId: "", questions: [] };
  }
}

/**
 * A tool call: a compact tappable row (action-verb label + a green/red edit stat for Edit/Write +
 * a chevron) that expands to its detail — the Bash command, or a diff viewer for a file edit, or the
 * Task prompt for a sub-agent. The diff is computed from the tool_use input (Edit old/new strings).
 */
function ToolRow({ text }: { text: string }) {
  const { name, input, sub } = parseToolUse(text);

  const isTask = name === "Task";
  const isEdit = name === "Edit" || name === "Write" || name === "MultiEdit";
  const file = input.file_path ? basename(input.file_path) : null;
  const stat = isEdit ? editStat(input) : null;
  const verb = isTask
    ? `Ran a sub-agent${input.description ? `: ${input.description}` : ""}`
    : isEdit && file
      ? `Edited ${file}`
      : name === "Read" && file
        ? `Read ${file}`
        : name === "Bash"
          ? input.description || "Ran a command"
          : `${name}${input.description ? `: ${input.description}` : ""}`;

  // Only expandable when the detail body will actually render something. `description` is already in
  // the label, and a Task's prompt is the only prompt we render — so don't open to an empty box.
  const hasDetail = Boolean(input.command || isEdit || (isTask && input.prompt));
  const glyph = isTask ? "🤖" : isEdit ? "✏️" : name === "Read" ? "📄" : name === "Bash" ? "❯" : "⚙";

  const row = (
    <span className="tool-line">
      <span className="tool-glyph">{glyph}</span>
      <span className="tool-label">{verb}</span>
      {stat && (
        <span className="tool-stat">
          {stat.add > 0 && <span className="stat-add">+{stat.add}</span>}
          {stat.del > 0 && <span className="stat-del">−{stat.del}</span>}
        </span>
      )}
    </span>
  );

  if (!hasDetail)
    return (
      <div className="tool-row" data-sub={sub}>
        {row}
      </div>
    );

  return (
    <details className="tool-row tool-row-x" data-sub={sub}>
      <summary>
        {row}
        <span className="chev">›</span>
      </summary>
      <div className="tool-detail">
        {input.command && (
          <Section label="Command">
            <pre className="code-block">{input.command}</pre>
          </Section>
        )}
        {isEdit && <DiffView input={input} />}
        {isTask && input.prompt && (
          <Section label="Prompt">
            <div className="detail-text">{input.prompt}</div>
          </Section>
        )}
      </div>
    </details>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-section">
      <div className="detail-label">{label}</div>
      {children}
    </div>
  );
}

/** A tool's Output (the worker's tool_result) — a compact collapsible row under the tool call. Empty
 *  output (no stdout) renders nothing so it doesn't clutter the transcript. */
function ToolResultRow({ text }: { text: string }) {
  const r = parseToolResult(text);
  if (r.output === "") return null;
  return (
    <details className="tool-result" data-error={r.isError} data-sub={r.sub}>
      <summary>
        <span className="tool-glyph">{r.isError ? "✕" : "↳"}</span>
        <span className="tool-label">{r.isError ? "Error" : "Output"}</span>
        <span className="chev">›</span>
      </summary>
      <pre className="code-block tool-output">{r.output}</pre>
    </details>
  );
}

/** A sub-agent Task lifecycle event (task_started/_updated/_notification) — a muted status line so a
 *  long-running Task is visible in the stream. */
function TaskRow({ text }: { text: string }) {
  const t = parseTask(text);
  const verb =
    t.subtype === "task_started"
      ? "Task started"
      : t.subtype === "task_notification"
        ? "Task update"
        : t.subtype === "task_updated"
          ? "Task progress"
          : "Task";
  return (
    <div className="task-row" data-sub>
      <span className="tool-glyph">🤖</span>
      <span className="tool-label">
        {verb}
        {t.description ? `: ${t.description}` : ""}
      </span>
    </div>
  );
}

const MAX_DIFF_LINES = 200; // cap each side so a large Write/Edit doesn't mount thousands of nodes

/** A diff viewer for a file edit — a path header over the changed lines (removed red / added green),
 *  computed from the tool_use input. See diffOf() for how a hunk is reduced to just its changes. */
function DiffView({ input }: { input: ToolInput }) {
  const path = input.file_path ?? "file";
  const { rem, add } = diffOf(input);
  if (rem.length === 0 && add.length === 0)
    return (
      <div className="diff">
        <div className="diff-path" title={path}>
          {basename(path)} <span className="diff-dir">{dirname(path)}</span>
        </div>
        <div className="diff-empty">no textual changes</div>
      </div>
    );
  return (
    <div className="diff">
      <div className="diff-path" title={path}>
        {basename(path)} <span className="diff-dir">{dirname(path)}</span>
      </div>
      <pre className="diff-body">
        {diffLines(rem.slice(0, MAX_DIFF_LINES), "dl-del", "−")}
        {more(rem.length - MAX_DIFF_LINES, "removed")}
        {diffLines(add.slice(0, MAX_DIFF_LINES), "dl-add", "+")}
        {more(add.length - MAX_DIFF_LINES, "added")}
      </pre>
    </div>
  );
}

function more(n: number, which: string): ReactNode {
  if (n <= 0) return null;
  return (
    <div className="dl dl-more">
      … {n} more {which} line{n === 1 ? "" : "s"}
    </div>
  );
}

// Render one side of a diff. Keyed by content + occurrence ordinal (not the array index): for an
// immutable, never-reordered diff that is a stable identity, and it keeps biome's array-index rule
// satisfied honestly rather than by suppression.
function diffLines(lines: string[], cls: string, sign: string): ReactNode[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    return (
      <div key={`${sign}${n}:${line}`} className={`dl ${cls}`}>
        <span className="dg">{sign}</span>
        {line}
      </div>
    );
  });
}

/** Render assistant prose with minimal markdown: **bold** and `inline code` (everything escaped). */
function Prose({ text, className }: { text: string; className: string }) {
  return <div className={`prose ${className}`}>{renderInline(text)}</div>;
}

function renderInline(text: string): ReactNode[] {
  // Split on `code` spans and **bold** runs; everything else is plain (auto-escaped) text.
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  let k = 0;
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <code key={`c${k}`} className="inline-code">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={`b${k}`}>{m[2]}</strong>);
    }
    last = re.lastIndex;
    k += 1;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
