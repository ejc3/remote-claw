"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
    </section>
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

interface ToolInput {
  command?: string;
  description?: string;
  prompt?: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}

/**
 * A tool call: a compact tappable row (action-verb label + a green/red edit stat for Edit/Write +
 * a chevron) that expands to its detail — the Bash command, or a diff viewer for a file edit, or the
 * Task prompt for a sub-agent. The diff is computed from the tool_use input (Edit old/new strings).
 */
function ToolRow({ text }: { text: string }) {
  let name = "tool";
  let input: ToolInput = {};
  let sub = false;
  try {
    const t = JSON.parse(text) as { name?: string; input?: ToolInput | null; sub?: boolean };
    name = typeof t.name === "string" ? t.name : "tool";
    input = t.input ?? {};
    sub = t.sub === true;
  } catch {}

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

  const hasDetail = Boolean(input.command || isEdit || input.prompt || input.description);
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

/** A diff viewer for a file edit — a path header + removed (old) lines in red, added (new) in green.
 *  Computed from the tool_use input (Edit's old_string→new_string; Write's content = all added). */
function DiffView({ input }: { input: ToolInput }) {
  const path = input.file_path ?? "file";
  const drop = (s: string) => {
    const lines = s.split("\n");
    return lines.length === 1 && lines[0] === "" ? [] : lines;
  };
  const rem = drop(input.old_string ?? "");
  const add = drop(input.new_string ?? input.content ?? "");
  return (
    <div className="diff">
      <div className="diff-path" title={path}>
        {basename(path)} <span className="diff-dir">{dirname(path)}</span>
      </div>
      <pre className="diff-body">
        {diffLines(rem, "dl-del", "−")}
        {diffLines(add, "dl-add", "+")}
      </pre>
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
      <div key={`${sign}${n} ${line}`} className={`dl ${cls}`}>
        <span className="dg">{sign}</span>
        {line}
      </div>
    );
  });
}

function editStat(input: ToolInput): { add: number; del: number } {
  const count = (s?: string) => (s && s !== "" ? s.split("\n").length : 0);
  return { add: count(input.new_string ?? input.content), del: count(input.old_string) };
}

function basename(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
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
