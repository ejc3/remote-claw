"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

function Bubble({ message }: { message: Message }) {
  if (message.kind === "result") {
    return <p className="turn-sep">turn complete</p>;
  }
  // A tool call (including `Task`, which spawns a sub-agent) — render the activity, not as chat.
  if (message.kind === "tool_use") return <ToolUse text={message.text} />;
  // A worker permission request (RC usually auto-executes, §17.4 — shown when it doesn't).
  if (message.kind === "permission_request") {
    let tool = "tool";
    try {
      tool = (JSON.parse(message.text) as { tool_name?: string }).tool_name ?? "tool";
    } catch {}
    return (
      <div className="tool-row">
        <span className="tool-chip">🔐 permission</span>
        <span className="tool-summary">{tool}</span>
      </div>
    );
  }
  // An extended-thinking block — the model's reasoning, shown muted/collapsible (not a reply). A
  // sub-agent's reasoning (`*_sub`) indents under its Task, matching assistant_sub.
  if (message.kind === "assistant_thinking" || message.kind === "assistant_thinking_sub") {
    const sub = message.kind === "assistant_thinking_sub";
    return (
      <details className="thinking" data-sub={sub}>
        <summary>💭 {sub ? "sub-agent thinking" : "thinking"}</summary>
        <div className="thinking-body">{message.text}</div>
      </details>
    );
  }
  // A sub-agent's reply (assistant output under a parent Task) — nested under the tool activity.
  if (message.kind === "assistant_sub") {
    return (
      <div className="bubble-row" data-me={false}>
        <div className="bubble bubble-sub">
          <span className="sub-tag">sub-agent</span>
          {message.text}
        </div>
      </div>
    );
  }
  // The transcript stream also carries meta acks (`accepted`) and lifecycle frames; only the actual
  // conversation (user prompts + assistant replies) belongs in the chat.
  if (message.kind !== "user" && message.kind !== "assistant") return null;
  const me = message.kind === "user";
  return (
    <div className="bubble-row" data-me={me}>
      <div className="bubble" data-me={me}>
        {message.text}
      </div>
    </div>
  );
}

/** Render a tool call. A `Task` is a sub-agent spawn (🤖); any other tool is generic activity (⚙). */
function ToolUse({ text }: { text: string }) {
  let name = "tool";
  let summary = "";
  try {
    const t = JSON.parse(text) as { name?: string; input?: unknown };
    name = typeof t.name === "string" ? t.name : "tool";
    const input = t.input as { command?: string; description?: string; prompt?: string } | null;
    summary = input?.description ?? input?.command ?? input?.prompt ?? "";
  } catch {
    summary = text;
  }
  const isTask = name === "Task";
  return (
    <div className="tool-row">
      <span className="tool-chip">
        {isTask ? "🤖" : "⚙"} {isTask ? "sub-agent" : name}
      </span>
      {summary ? <span className="tool-summary">{summary.slice(0, 120)}</span> : null}
    </div>
  );
}
