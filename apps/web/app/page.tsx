"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Announce, FRESH_WINDOW_MS, type Message, Viewer } from "./lib/viewer";

export default function Home() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [passInput, setPassInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // On load, a pass may arrive in the URL fragment (#rcp1_…) — the fragment is never sent to the
  // server. Prefill it, then strip it from the address bar so it doesn't linger in history.
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

function Connect(props: {
  pass: string;
  setPass: (s: string) => void;
  connect: (s: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "10vh 20px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>remote-claw</h1>
      <p style={{ color: "#9a9aa2", marginTop: 0 }}>
        Paste a machine <strong>pass</strong> to drive its claude sessions, end-to-end encrypted.
        The broker never sees your keys or your messages.
      </p>
      <textarea
        value={props.pass}
        onChange={(e) => props.setPass(e.target.value)}
        placeholder="rcp1_…"
        spellCheck={false}
        rows={3}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: 12,
          fontFamily: "ui-monospace, monospace",
          fontSize: 13,
          background: "#161618",
          color: "#e8e8ea",
          border: "1px solid #2a2a2e",
          borderRadius: 8,
          resize: "vertical",
        }}
      />
      <button
        type="button"
        disabled={props.connecting || props.pass.trim() === ""}
        onClick={() => props.connect(props.pass)}
        style={{
          marginTop: 12,
          padding: "10px 18px",
          fontSize: 15,
          background: props.pass.trim() === "" ? "#26262a" : "#3b6ef5",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          cursor: props.connecting ? "wait" : "pointer",
        }}
      >
        {props.connecting ? "Connecting…" : "Connect"}
      </button>
      {props.error !== null && (
        <p style={{ color: "#ff6b6b", marginTop: 12 }}>Couldn’t load that pass: {props.error}</p>
      )}
      <p style={{ color: "#6b6b73", marginTop: 24, fontSize: 13 }}>
        Get a pass on the machine with <code>remote-claw --rc-pass</code>. A pass can read and steer
        that machine’s sessions but is not the master secret.
      </p>
    </main>
  );
}

function Console(props: { viewer: Viewer; onForget: () => void }) {
  const { viewer } = props;
  const [sessions, setSessions] = useState<Map<string, Announce>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Tail the bus → live session list.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        for await (const a of viewer.announces(ac.signal)) {
          setSessions((prev) => {
            const next = new Map(prev);
            const existing = next.get(a.sessionId);
            // Keep the freshest sent_at we've seen for a session (replay-safe presence).
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

  // Presence is timestamp-driven; re-evaluate "online" on a timer so rows grey out as announces lapse.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const list = [...sessions.values()].sort((a, b) => b.sentAt - a.sentAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #1f1f23",
        }}
      >
        <strong style={{ fontSize: 16 }}>remote-claw</strong>
        <span style={{ color: "#6b6b73", fontSize: 13 }}>
          {list.length} session{list.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={props.onForget}
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            fontSize: 13,
            background: "#161618",
            color: "#e8e8ea",
            border: "1px solid #2a2a2e",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Forget pass
        </button>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav
          style={{
            width: 240,
            borderRight: "1px solid #1f1f23",
            overflowY: "auto",
            flexShrink: 0,
          }}
        >
          {list.length === 0 && (
            <p style={{ color: "#6b6b73", fontSize: 13, padding: 16 }}>
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
                onClick={() => setSelected(s.sessionId)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 14px",
                  background: selected === s.sessionId ? "#1a1a1e" : "transparent",
                  color: online ? "#e8e8ea" : "#7a7a82",
                  border: "none",
                  borderBottom: "1px solid #141417",
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: online ? "#3ad29f" : "#44444a",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.title}
                  </span>
                </span>
                {s.cwd !== null && (
                  <span style={{ display: "block", color: "#6b6b73", fontSize: 11, marginTop: 2 }}>
                    {s.cwd}
                  </span>
                )}
              </button>
            );
          })}
          {streamError !== null && (
            <p style={{ color: "#ff6b6b", fontSize: 12, padding: 12 }}>{streamError}</p>
          )}
        </nav>

        {selected === null ? (
          <div
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              color: "#6b6b73",
              padding: 24,
            }}
          >
            Pick a session to open its transcript.
          </div>
        ) : (
          <Transcript key={selected} viewer={viewer} sessionId={selected} />
        )}
      </div>
    </div>
  );
}

function Transcript(props: { viewer: Viewer; sessionId: string }) {
  const { viewer, sessionId } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Open: ask the host to replay history, then tail the session out-stream.
  useEffect(() => {
    setMessages([]);
    const ac = new AbortController();
    void viewer.requestHistory(sessionId, 0).catch(() => {
      /* best-effort; the host may be offline */
    });
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the latest on every new message.
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
      // A failed publish (broker 409 = run rolled, or the host is offline) — surface it, keep the text.
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [input, sessionId, viewer]);

  return (
    <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.length === 0 && <p style={{ color: "#6b6b73" }}>Waiting for the transcript…</p>}
        {messages.map((m) => (
          <Bubble key={`${m.msgId}:${m.seq}`} message={m} />
        ))}
        <div ref={endRef} />
      </div>
      {sendError !== null && (
        <p style={{ color: "#ff6b6b", fontSize: 12, margin: 0, padding: "6px 12px" }}>
          Couldn’t send: {sendError}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #1f1f23" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a prompt…"
          style={{
            flex: 1,
            padding: "10px 12px",
            fontSize: 15,
            background: "#161618",
            color: "#e8e8ea",
            border: "1px solid #2a2a2e",
            borderRadius: 8,
          }}
        />
        <button
          type="submit"
          disabled={sending || input.trim() === ""}
          style={{
            padding: "10px 16px",
            fontSize: 15,
            background: input.trim() === "" ? "#26262a" : "#3b6ef5",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: sending ? "wait" : "pointer",
          }}
        >
          Send
        </button>
      </form>
    </section>
  );
}

function Bubble({ message }: { message: Message }) {
  const isUser = message.kind === "user";
  const isResult = message.kind === "result";
  if (isResult) {
    return (
      <p style={{ color: "#6b6b73", fontSize: 12, textAlign: "center", margin: "8px 0" }}>
        — turn complete —
      </p>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "6px 0",
      }}
    >
      <div
        style={{
          maxWidth: "78%",
          padding: "8px 12px",
          borderRadius: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: isUser ? "#3b6ef5" : "#1a1a1e",
          color: isUser ? "#fff" : "#e8e8ea",
          fontSize: 14,
        }}
      >
        {message.text}
      </div>
    </div>
  );
}
