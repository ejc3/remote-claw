"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  basename,
  diffOf,
  dirname,
  editStat,
  parseToolUse,
  type ToolInput,
} from "./lib/transcript";
import { type Announce, FRESH_WINDOW_MS, type Message, Viewer } from "./lib/viewer";

export default function Home() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [passInput, setPassInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // A pass may arrive in the URL fragment (#rcp1_…) — never sent to the server. Prefill, then strip
  // it from the address bar so it doesn't linger in history.
  useEffect(() => {
    const frag = window.location.hash.replace(/^#/, "");
    if (frag.startsWith("rcp1_")) {
      setPassInput(frag);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  const connect = useCallback(async (pass: string) => {
    setError(null);
    setConnecting(true);
    try {
      setViewer(await Viewer.fromPass(pass));
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
  return <Console viewer={viewer} onForget={() => setViewer(null)} />;
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

function relativeTime(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < FRESH_WINDOW_MS) return "online";
  const mins = Math.floor(d / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
            if (existing === undefined || a.sentAt >= existing.sentAt) next.set(a.sessionId, a);
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
            const online = now - s.sentAt < FRESH_WINDOW_MS;
            return (
              <button
                type="button"
                key={s.sessionId}
                className="row"
                data-active={selected === s.sessionId}
                data-online={online}
                onClick={() => setSelected(s.sessionId)}
              >
                <span className="row-top">
                  <span className="dot" data-online={online} />
                  <span className="row-title">{s.title}</span>
                </span>
                <span className="row-sub">
                  {s.cwd !== null ? `${s.cwd} · ` : ""}
                  {relativeTime(s.sentAt, now)}
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
  onBack: () => void;
}) {
  const { viewer, sessionId } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The session's real permission mode lives on the worker and isn't announced, so we track the last
  // mode set from here (optimistic): null = "we haven't set one". setMode is fire-and-forget.
  const [mode, setMode] = useState<string | null>(null);
  const [modeSheet, setModeSheet] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMessages([]);
    const ac = new AbortController();
    void viewer.requestHistory(sessionId, 0).catch(() => {});
    (async () => {
      try {
        for await (const m of viewer.transcript(sessionId, ac.signal)) {
          setMessages((prev) => [...prev, m]);
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

  const chooseMode = useCallback(
    async (id: string) => {
      setModeSheet(false);
      setSendError(null);
      const prev = mode;
      setMode(id); // optimistic — revert if the control frame can't be sent
      try {
        await viewer.setMode(sessionId, id);
      } catch (e) {
        // Only revert if no newer choice landed while we were awaiting — else we'd clobber it.
        setMode((cur) => (cur === id ? prev : cur));
        setSendError(e instanceof Error ? e.message : String(e));
      }
    },
    [mode, sessionId, viewer],
  );

  return (
    <section className="chat">
      <div className="chat-head">
        <button type="button" className="back" onClick={props.onBack}>
          ‹ Sessions
        </button>
        <span className="row-title">{props.title}</span>
      </div>

      <div className="transcript">
        {messages.length === 0 && <p className="empty-pad">Waiting for the transcript…</p>}
        {messages.map((m) => (
          <Bubble key={`${m.msgId}:${m.seq}`} message={m} />
        ))}
        <div ref={endRef} />
      </div>

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
          <span className="mode-glyph">{modeGlyph(mode)}</span>
          {modeLabel(mode)}
        </button>
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
          current={mode}
          onPick={(id) => void chooseMode(id)}
          onClose={() => setModeSheet(false)}
        />
      )}
    </section>
  );
}

// The three permission modes Claude Code exposes (IMG_1825 "Select mode"). `id` is the RC
// set_permission_mode value the relay forwards to the worker (§3.7): Auto = default (Claude asks on
// risky actions), Code = acceptEdits (edits applied directly), Plan = read-only plan-first.
const MODES = [
  {
    id: "default",
    label: "Auto",
    glyph: "◍",
    desc: "Claude decides which actions need confirmation",
  },
  { id: "acceptEdits", label: "Code", glyph: "⌨", desc: "Claude writes and edits code directly" },
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
function Bubble({ message }: { message: Message }) {
  switch (message.kind) {
    case "result":
      return <p className="turn-sep" aria-hidden />;
    case "user":
      return (
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
    case "permission_request":
      return <PermissionRow text={message.text} />;
    default:
      // accepted acks + lifecycle frames are not part of the rendered conversation.
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

/** A worker permission request (RC usually auto-executes, §17.4 — shown when it doesn't). */
function PermissionRow({ text }: { text: string }) {
  let tool = "tool";
  try {
    tool = (JSON.parse(text) as { tool_name?: string }).tool_name ?? "tool";
  } catch {}
  return (
    <div className="tool-row">
      <span className="tool-glyph">🔐</span>
      <span className="tool-label">permission · {tool}</span>
    </div>
  );
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
