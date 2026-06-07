"""Client face: the web UI + token-gated JSON/SSE API our own client uses.

Security:
  • All `/api/*` and the UI require a bearer token (header, cookie, or ?token=).
  • `/healthz` is unauthenticated (liveness only).
  • Binds to localhost unless explicitly exposed; constant-time token compare.
"""

from __future__ import annotations

import contextlib
import hmac
import http.cookies
import json
import re
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .core import Event, RelayCore
from .log import get

log = get()

MAX_INPUT = 100_000  # max user message length accepted from a client
_SID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

UI_HTML = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>remote-claw</title><style>
body{font:14px/1.5 system-ui;margin:0;display:flex;flex-direction:column;height:100vh}
header{padding:8px 12px;background:#111;color:#eee;display:flex;gap:8px;align-items:center}
header b{color:#fff}select{padding:6px}
#log{flex:1;overflow:auto;padding:12px}
.row{margin:4px 0;white-space:pre-wrap;word-break:break-word}
.u{color:#06c}.a{color:#0a0}.r{color:#999;font-size:12px}.t{color:#a60}
#bar{display:flex;gap:6px;padding:8px;border-top:1px solid #ccc}
#msg{flex:1;padding:8px;font:inherit}button{padding:8px 14px}
</style></head><body>
<header><b>remote-claw</b><select id=sess></select><span id=stat class=r></span></header>
<div id=log></div>
<div id=bar><input id=msg placeholder="message — drives the same session as the TUI">
<button onclick=send()>Send</button></div>
<script>
let sid=null,es=null;
function api(p,o){return fetch(p,o)}  // same-origin cookie carries the token
async function loadSessions(){let d=await(await api('/api/sessions')).json();
 let s=document.getElementById('sess'),cur=s.value;s.innerHTML='';
 d.sessions.forEach(x=>{let o=document.createElement('option');o.value=x.id;
  o.text=x.title+' ('+x.id.slice(0,10)+')';s.add(o)});
 if(cur)s.value=cur;
 if(!sid&&d.sessions.length){connect()}}
function connect(){sid=document.getElementById('sess').value;if(es)es.close();
 document.getElementById('log').innerHTML='';
 es=new EventSource('/api/sessions/'+sid+'/stream');
 es.onmessage=e=>add(JSON.parse(e.data));
 es.onerror=()=>document.getElementById('stat').textContent='(reconnecting…)';
 es.onopen=()=>document.getElementById('stat').textContent='live';}
function add(p){let l=document.getElementById('log'),d=document.createElement('div');d.className='row ';
 if(p.type=='assistant'){d.className+='a';d.textContent='assistant: '+(p.text||'')}
 else if(p.type=='user'){d.className+='u';d.textContent='user: '+(p.text||'')}
 else if(p.type=='result'){d.className+='r';d.textContent='— turn complete —'}
 else if(p.type=='control_request'){d.className+='t';d.textContent='permission? '+(p.tool_name||p.subtype||'')}
 else{d.className+='r';d.textContent=p.type}
 l.appendChild(d);l.scrollTop=l.scrollHeight}
async function send(){let m=document.getElementById('msg');if(!m.value||!sid)return;
 let v=m.value;m.value='';
 await api('/api/sessions/'+sid+'/input',{method:'POST',
   headers:{'content-type':'application/json'},body:JSON.stringify({content:v})});}
document.getElementById('sess').onchange=connect;
document.getElementById('msg').addEventListener('keydown',e=>{if(e.key=='Enter')send()});
loadSessions();setInterval(loadSessions,5000);
</script></body></html>"""

UNAUTH_HTML = """<!doctype html><meta charset=utf-8><title>remote-claw</title>
<body style="font:15px system-ui;max-width:40em;margin:4em auto;padding:0 1em">
<h2>remote-claw</h2><p>This page needs the access token. Open the URL printed by
<code>remote-claw up</code> (it includes <code>?token=…</code>), or paste your
token:</p>
<form><input name=token style="width:70%;padding:8px" placeholder="token">
<button>Open</button></form></body>"""


class _Handler(BaseHTTPRequestHandler):
    core: RelayCore
    token: str
    server_version = "remote-claw"
    protocol_version = "HTTP/1.1"

    def __init__(self, *a: Any, core: RelayCore, token: str, **kw: Any):
        self.core = core
        self.token = token
        super().__init__(*a, **kw)

    def log_message(self, *a: Any) -> None:  # quiet; we use our own logger
        pass

    # ---- auth ----
    def _presented_token(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        c = self.headers.get("Cookie")
        if c:
            ck = http.cookies.SimpleCookie(c)
            if "rc_token" in ck:
                return ck["rc_token"].value
        m = re.search(r"[?&]token=([^&]+)", self.path)
        if m:
            return m.group(1)
        return None

    def _authed(self) -> bool:
        t = self._presented_token()
        return bool(t) and hmac.compare_digest(t, self.token)

    # ---- responses ----
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(body)

    def _json(self, obj: Any, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    # ---- routing ----
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._json({"ok": True, "sessions": len(self.core.list())})
        if path == "/":
            tok = self._presented_token()
            if tok and hmac.compare_digest(tok, self.token):
                cookie = f"rc_token={self.token}; Path=/; HttpOnly; SameSite=Strict"
                return self._send(200, UI_HTML.encode(), "text/html; charset=utf-8", {"Set-Cookie": cookie})
            return self._send(401, UNAUTH_HTML.encode(), "text/html; charset=utf-8")
        if not self._authed():
            return self._json({"error": "unauthorized"}, 401)
        if path == "/api/sessions":
            return self._json({"sessions": [s.session_obj() for s in self.core.list()]})
        m = re.match(r"^/api/sessions/([^/]+)/events$", path)
        if m:
            return self._events(m.group(1))
        m = re.match(r"^/api/sessions/([^/]+)/stream$", path)
        if m:
            return self._stream(m.group(1))
        self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if not self._authed():
            return self._json({"error": "unauthorized"}, 401)
        path = self.path.split("?", 1)[0]
        body = self._read_json()
        if body is None:
            return self._json({"error": "invalid json"}, 400)
        m = re.match(r"^/api/sessions/([^/]+)/input$", path)
        if m:
            return self._input(m.group(1), body)
        m = re.match(r"^/api/sessions/([^/]+)/permission$", path)
        if m:
            return self._permission(m.group(1), body)
        self._json({"error": "not found"}, 404)

    # ---- handlers ----
    def _read_json(self) -> dict | None:
        try:
            n = int(self.headers.get("content-length", 0))
        except ValueError:
            return None
        if n > MAX_INPUT * 2:
            return None
        raw = self.rfile.read(n) if n else b"{}"
        try:
            obj = json.loads(raw or b"{}")
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None

    def _session(self, sid: str):
        if not _SID_RE.match(sid):
            self._json({"error": "bad session id"}, 400)
            return None
        s = self.core.get(sid)
        if not s:
            self._json({"error": "no such session"}, 404)
            return None
        return s

    def _input(self, sid: str, body: dict) -> None:
        s = self._session(sid)
        if not s:
            return
        content = body.get("content")
        if not isinstance(content, str) or not content.strip():
            return self._json({"error": "content must be a non-empty string"}, 400)
        if len(content) > MAX_INPUT:
            return self._json({"error": "content too long"}, 413)
        s.push_user_input(content)
        log.info("⇢ client input (%s): %d chars", sid[:12], len(content))
        self._json({"ok": True})

    def _permission(self, sid: str, body: dict) -> None:
        s = self._session(sid)
        if not s:
            return
        rid = body.get("request_id")
        behavior = body.get("behavior", "allow")
        if not isinstance(rid, str) or behavior not in ("allow", "deny"):
            return self._json({"error": "request_id + behavior(allow|deny) required"}, 400)
        s.push_control_response(rid, behavior)
        self._json({"ok": True})

    def _events(self, sid: str) -> None:
        s = self._session(sid)
        if not s:
            return
        self._json({"events": [_client_event(e) for e in s.snapshot_upstream()]})

    def _stream(self, sid: str) -> None:
        s = self._session(sid)
        if not s:
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for ev in s.follow_upstream(lambda: False):
                if ev is None:
                    self.wfile.write(b": keepalive\n\n")
                else:
                    self.wfile.write((f"data: {json.dumps(_client_event(ev))}\n\n").encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def _client_event(e: Event) -> dict[str, Any]:
    p = e.payload
    t = p.get("type")
    out: dict[str, Any] = {"type": t, "seq": e.sequence_num, "source": e.source}
    if t == "assistant":
        out["text"] = "".join(
            b.get("text", "")
            for b in p.get("message", {}).get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        )
    elif t == "user":
        msg = p.get("message", {}).get("content")
        out["text"] = msg if isinstance(msg, str) else "[tool_result]"
    elif t == "control_request":
        req = p.get("request", {})
        out.update(
            subtype=req.get("subtype"),
            tool_name=req.get("tool_name"),
            request_id=p.get("request_id") or req.get("request_id"),
        )
    return out


class _ThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class ClientServer:
    def __init__(self, cfg, core: RelayCore, token: str):
        host = "0.0.0.0" if cfg.expose else cfg.client_host
        handler = partial(_Handler, core=core, token=token)
        self._httpd = _ThreadingHTTPServer((host, cfg.client_port), handler)
        self.host = host
        self.port = cfg.client_port

    def serve(self) -> None:
        self._httpd.serve_forever(poll_interval=0.5)

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
