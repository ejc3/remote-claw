#!/usr/bin/env python3
"""remote-claw relay (Option 2: own-relay via api.anthropic.com MITM).

Two faces:
  1. MITM face  — a forward proxy claude is pointed at (HTTPS_PROXY). It INTERCEPTS
     the Remote Control endpoints (/v1/code/sessions*, /v1/code/triggers) and serves
     them from RelayCore, becoming the worker's backend. Everything else
     (esp. /v1/messages inference, oauth/token) is passed through to the REAL
     api.anthropic.com so the session keeps working.
  2. Client face — a plain HTTP server (port 9100) our own UI talks to: list
     sessions, send user turns, stream assistant output. No proxy/cert needed.

Run:
  python3 relay.py
Launch the worker against it:
  HTTPS_PROXY=http://127.0.0.1:8888 NODE_EXTRA_CA_CERTS=<certs>/ca.pem \
    claude --remote-control phase0 --verbose
Open the UI:  http://127.0.0.1:9100/

Wire format reverse-engineered + verified in docs/phase0-findings.md §4b.
"""
import argparse, datetime, json, os, re, select, socket, ssl, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CERTS = os.path.abspath(os.path.join(HERE, "..", "mitm", "certs"))
MITM_HOST = "api.anthropic.com"

ap = argparse.ArgumentParser()
ap.add_argument("--proxy-port", type=int, default=8888)
ap.add_argument("--client-port", type=int, default=9100)
ap.add_argument("--verbose", action="store_true")
args = ap.parse_args()

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def log(*a):
    sys.stdout.write("[%s] %s\n" % (now_iso(), " ".join(str(x) for x in a)))
    sys.stdout.flush()

def vlog(*a):
    if args.verbose:
        log(*a)

# ───────────────────────────── RelayCore ─────────────────────────────
class Session:
    def __init__(self, sid, title, config):
        self.id = sid
        self.title = title
        self.config = config or {}
        self.created_at = now_iso()
        self.worker_epoch = 1
        self.worker_status = "WORKER_STATUS_UNSPECIFIED"
        self.lock = threading.Condition()
        self.downstream = []     # events relay -> worker (SSE)
        self.upstream = []       # events worker -> relay (fanned to clients)
        self.ds_seq = 0
        self.us_seq = 0
        self.initialized = False

    def session_obj(self):
        return {
            "id": self.id, "title": self.title, "status": "active",
            "environment_kind": "bridge", "environment_id": "",
            "worker_status": self.worker_status, "connection_status": "connected",
            "created_at": self.created_at, "updated_at": now_iso(),
            "last_event_at": now_iso(), "participants": [], "client_presence": [],
            "tags": ["remote-control-repl"], "security_tier": "standard",
            "unread": False, "config": self.config,
        }

    def push_control_response(self, request_id, behavior="allow"):
        """Answer a worker can_use_tool/control_request (client decision)."""
        return self.push_downstream("control_response", {
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request_id,
                         "response": {"behavior": behavior}},
        })

    def push_downstream(self, event_type, payload):
        with self.lock:
            self.ds_seq += 1
            eid = str(uuid.uuid4())
            payload.setdefault("uuid", eid)
            ev = {
                "event_id": eid, "sequence_num": str(self.ds_seq),
                "event_type": event_type, "source": "client",
                "payload": payload, "created_at": now_iso(),
            }
            self.downstream.append(ev)
            self.lock.notify_all()
            return ev

    def push_upstream(self, payload):
        dbg = os.environ.get("RELAY_DUMP_UPSTREAM")
        if dbg:
            try:
                with open(dbg, "a") as fh:
                    fh.write(json.dumps(payload) + "\n")
            except Exception:
                pass
        with self.lock:
            self.us_seq += 1
            ev = {
                "event_id": payload.get("uuid", str(uuid.uuid4())),
                "sequence_num": str(self.us_seq),
                "event_type": payload.get("type"), "source": "worker",
                "payload": payload, "created_at": now_iso(),
            }
            self.upstream.append(ev)
            self.lock.notify_all()
            return ev

class RelayCore:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()

    def create(self, body):
        sid = "cse_" + uuid.uuid4().hex[:22]
        s = Session(sid, body.get("title", "remote-claw"), body.get("config"))
        with self.lock:
            self.sessions[sid] = s
        log("session created:", sid, "title=", s.title)
        return s

    def get(self, sid):
        with self.lock:
            return self.sessions.get(sid)

    def list(self):
        with self.lock:
            return list(self.sessions.values())

CORE = RelayCore()

# ─────────────────────────── MITM machinery ───────────────────────────
srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
srv_ctx.load_cert_chain(os.path.join(CERTS, "leaf.pem"), os.path.join(CERTS, "leaf.key"))
srv_ctx.set_alpn_protocols(["http/1.1"])
up_ctx = ssl.create_default_context()
up_ctx.set_alpn_protocols(["http/1.1"])

def recv_headers(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            return None
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head + b"\r\n\r\n", rest

def parse_req(head_bytes):
    text = head_bytes.decode("latin1")
    line, _, hdrs = text.partition("\r\n")
    h = {}
    for ln in hdrs.split("\r\n"):
        if ":" in ln:
            k, v = ln.split(":", 1)
            h[k.strip().lower()] = v.strip()
    parts = line.split(" ")
    return (parts + ["", ""])[0], (parts + ["", ""])[1], h

def read_body(sock, headers, already):
    if "content-length" in headers:
        n = int(headers["content-length"]); body = already
        while len(body) < n:
            c = sock.recv(min(65536, n - len(body)))
            if not c: break
            body += c
        return body
    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = already
        while b"0\r\n\r\n" not in body:
            c = sock.recv(65536)
            if not c: break
            body += c
        # de-chunk
        out = b""; b = body
        while b"\r\n" in b:
            sz, b = b.split(b"\r\n", 1)
            try: n = int(sz.split(b";")[0], 16)
            except ValueError: break
            if n == 0: break
            out += b[:n]; b = b[n+2:]
        return out
    return already

def send_json(tls, obj, status="200 OK"):
    body = json.dumps(obj).encode()
    tls.sendall(("HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
                 % (status, len(body))).encode() + body)

INTERCEPT_RE = re.compile(r"^/v1/code/(sessions|triggers)")

def handle_intercept(tls, method, path, headers, body):
    """Serve Remote Control endpoints from RelayCore."""
    p = path.split("?", 1)[0]
    bj = {}
    if body:
        try: bj = json.loads(body)
        except Exception: bj = {}

    # triggers
    if p == "/v1/code/triggers":
        return send_json(tls, {"data": []})

    # create session
    if p == "/v1/code/sessions" and method == "POST":
        s = CORE.create(bj)
        return send_json(tls, {"session": s.session_obj()})

    m = re.match(r"^/v1/code/sessions/([^/]+)(/.*)?$", p)
    if not m:
        return send_json(tls, {"error": "not found"}, "404 Not Found")
    sid, sub = m.group(1), (m.group(2) or "")
    s = CORE.get(sid)
    if not s:
        return send_json(tls, {"error": "no session"}, "404 Not Found")

    if sub == "" and method == "GET":
        return send_json(tls, {"session": s.session_obj()})

    if sub == "/bridge":
        jwt = "sk-ant-si-" + uuid.uuid4().hex
        return send_json(tls, {"api_base_url": "https://api.anthropic.com",
                               "expires_in": 14400, "worker_epoch": "1", "worker_jwt": jwt})

    if sub == "/worker" and method == "GET":
        return send_json(tls, {"worker": {"session_id": sid, "worker_epoch": str(s.worker_epoch),
                                          "worker_status": s.worker_status}})
    if sub == "/worker" and method == "PUT":
        if "worker_status" in bj:
            s.worker_status = bj["worker_status"]
        vlog("worker PUT", sid, bj.get("worker_status"))
        return send_json(tls, {})

    if sub == "/worker/heartbeat":
        return send_json(tls, {})

    if sub == "/worker/events/delivery":
        return send_json(tls, {})

    if sub == "/worker/events" and method == "POST":
        # host -> relay output events (assistant/result/control_response/...)
        for ev in bj.get("events", []):
            payload = ev.get("payload", {})
            s.push_upstream(payload)
            t = payload.get("type")
            if t == "assistant":
                txt = "".join(b.get("text", "") for b in payload.get("message", {}).get("content", [])
                              if isinstance(b, dict))
                log("⇠ assistant:", repr(txt)[:80])
        return send_json(tls, {})

    if sub == "/worker/events/stream" and method == "GET":
        return stream_worker(tls, s)

    return send_json(tls, {}, "200 OK")

def stream_worker(tls, s):
    """Long-lived SSE: relay -> worker. Sends initialize once, then client events."""
    tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                b"Cache-Control: no-cache\r\nConnection: close\r\n\r\n")
    if not s.initialized:
        s.initialized = True
        s.push_downstream("control_request", {
            "request": {"subtype": "initialize"}, "request_id": str(uuid.uuid4()),
            "type": "control_request"})
    log("worker SSE connected:", s.id)
    sent = 0
    try:
        while True:
            with s.lock:
                while sent >= len(s.downstream):
                    if not s.lock.wait(timeout=10):
                        break
                pending = s.downstream[sent:]
                sent = len(s.downstream)
            if not pending:
                try: tls.sendall(b":keepalive\n\n")
                except Exception: break
                continue
            for ev in pending:
                frame = ("event: client_event\nid: %s\ndata: %s\n\n"
                         % (ev["sequence_num"], json.dumps(ev))).encode()
                tls.sendall(frame)
                vlog("⇢ worker:", ev["event_type"], ev["payload"].get("type", ""))
    except Exception as e:
        vlog("worker SSE closed:", e)

def passthrough(tls, method, path, headers, body):
    """Forward to the REAL api.anthropic.com (inference, oauth, telemetry, ...)."""
    raw = socket.create_connection((MITM_HOST, 443), timeout=300)
    up = up_ctx.wrap_socket(raw, server_hostname=MITM_HOST)
    hdr_lines = ["%s: %s" % (k, v) for k, v in headers.items()
                 if k.lower() not in ("connection", "proxy-connection", "keep-alive")]
    hdr_lines.append("Connection: close")
    req = ("%s %s HTTP/1.1\r\n" % (method, path)) + "\r\n".join(hdr_lines) + "\r\n\r\n"
    up.sendall(req.encode("latin1") + body)
    # relay raw response back until upstream closes
    while True:
        try: c = up.recv(65536)
        except Exception: break
        if not c: break
        try: tls.sendall(c)
        except Exception: break
    up.close()

def handle_mitm_conn(tls):
    r = recv_headers(tls)
    if not r:
        return
    head, rest = r
    method, path, headers = parse_req(head)
    body = read_body(tls, headers, rest)
    if INTERCEPT_RE.match(path.split("?", 1)[0]):
        vlog("INTERCEPT", method, path)
        handle_intercept(tls, method, path, headers, body)
    else:
        passthrough(tls, method, path, headers, body)

def blind_tunnel(client, host, port):
    try:
        up = socket.create_connection((host, port), timeout=30)
    except Exception:
        client.close(); return
    client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    socks = [client, up]
    try:
        while True:
            r, _, _ = select.select(socks, [], [], 120)
            if not r: break
            for sx in r:
                data = sx.recv(65536)
                if not data: return
                (up if sx is client else client).sendall(data)
    except Exception:
        pass
    finally:
        client.close(); up.close()

def proxy_client(client):
    try:
        r = recv_headers(client)
        if not r:
            client.close(); return
        head, _ = r
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        parts = line.split(" ")
        if parts[0] != "CONNECT":
            client.close(); return
        host, _, port = parts[1].partition(":")
        port = int(port or 443)
        if host == MITM_HOST:
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            try:
                tls = srv_ctx.wrap_socket(client, server_side=True)
            except Exception as e:
                vlog("client TLS fail", e); client.close(); return
            try:
                handle_mitm_conn(tls)
            finally:
                try: tls.close()
                except Exception: pass
        else:
            blind_tunnel(client, host, port)
    except Exception as e:
        vlog("proxy err", e)
        try: client.close()
        except Exception: pass

def run_proxy():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", args.proxy_port)); srv.listen(128)
    log("MITM proxy on http://127.0.0.1:%d (intercepts %s /v1/code/*)" % (args.proxy_port, MITM_HOST))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=proxy_client, args=(c,), daemon=True).start()

# ─────────────────────────── Client face ───────────────────────────
UI_HTML = """<!doctype html><html><head><meta charset=utf-8>
<title>remote-claw</title><style>
body{font:14px system-ui;margin:0;display:flex;flex-direction:column;height:100vh}
#log{flex:1;overflow:auto;padding:12px;white-space:pre-wrap}
.u{color:#06c}.a{color:#080}.r{color:#888}
#bar{display:flex;gap:6px;padding:8px;border-top:1px solid #ccc}
#msg{flex:1;padding:8px}select,button{padding:8px}
</style></head><body>
<div id=bar><select id=sess></select><input id=msg placeholder="type a message… (drives the same session as the TUI)">
<button onclick=send()>Send</button></div>
<div id=log></div>
<script>
let sid=null,es=null;
async function loadSessions(){let r=await fetch('/api/sessions');let d=await r.json();
 let s=document.getElementById('sess');s.innerHTML='';
 d.sessions.forEach(x=>{let o=document.createElement('option');o.value=x.id;o.text=x.title+' ('+x.id.slice(0,12)+')';s.add(o)});
 if(d.sessions.length){sid=d.sessions[0].id;connect()}}
function connect(){sid=document.getElementById('sess').value;if(es)es.close();
 document.getElementById('log').textContent='';
 es=new EventSource('/api/sessions/'+sid+'/stream');
 es.onmessage=e=>{let p=JSON.parse(e.data);add(p)}}
function add(p){let l=document.getElementById('log');let d=document.createElement('div');
 if(p.type=='assistant'){d.className='a';d.textContent='assistant: '+(p.text||'')}
 else if(p.type=='result'){d.className='r';d.textContent='— turn complete —'}
 else if(p.type=='user'){d.className='u';d.textContent='you: '+(p.text||'')}
 else{d.className='r';d.textContent=p.type}
 l.appendChild(d);l.scrollTop=l.scrollHeight}
async function send(){let m=document.getElementById('msg');if(!m.value||!sid)return;
 add({type:'user',text:m.value});
 await fetch('/api/sessions/'+sid+'/input',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({content:m.value})});m.value=''}
document.getElementById('sess').onchange=connect;
document.getElementById('msg').addEventListener('keydown',e=>{if(e.key=='Enter')send()});
loadSessions();setInterval(loadSessions,5000);
</script></body></html>"""

class ClientHandler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            b = UI_HTML.encode()
            self.send_response(200); self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        if self.path == "/api/sessions":
            return self._json({"sessions": [s.session_obj() for s in CORE.list()]})
        m = re.match(r"^/api/sessions/([^/]+)/events$", self.path)
        if m:
            s = CORE.get(m.group(1))
            if not s:
                return self._json({"error": "no session"}, 404)
            out = []
            with s.lock:
                for ev in s.upstream:
                    p = ev["payload"]; t = p.get("type")
                    item = {"type": t, "seq": ev["sequence_num"], "source": ev.get("source")}
                    if t == "assistant":
                        item["text"] = "".join(b.get("text", "") for b in p.get("message", {}).get("content", [])
                                              if isinstance(b, dict))
                    elif t == "user":
                        msg = p.get("message", {}).get("content")
                        item["text"] = msg if isinstance(msg, str) else "[tool_result]"
                    out.append(item)
            return self._json({"events": out})
        m = re.match(r"^/api/sessions/([^/]+)/stream$", self.path)
        if m:
            return self.stream(m.group(1))
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        m = re.match(r"^/api/sessions/([^/]+)/input$", self.path)
        if m:
            n = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            s = CORE.get(m.group(1))
            if not s:
                return self._json({"error": "no session"}, 404)
            payload = {"type": "user", "message": {"role": "user", "content": body.get("content", "")},
                       "session_id": s.id, "timestamp": now_iso(), "parent_tool_use_id": None}
            s.push_downstream("user", payload)
            log("⇢ client input:", repr(body.get("content", ""))[:60])
            return self._json({"ok": True})
        m = re.match(r"^/api/sessions/([^/]+)/permission$", self.path)
        if m:
            n = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
            s = CORE.get(m.group(1))
            if not s:
                return self._json({"error": "no session"}, 404)
            s.push_control_response(body.get("request_id"), body.get("behavior", "allow"))
            log("⇢ permission decision:", body.get("behavior"), body.get("request_id"))
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    def stream(self, sid):
        s = CORE.get(sid)
        if not s:
            return self._json({"error": "no session"}, 404)
        self.send_response(200); self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache"); self.send_header("Connection", "close")
        self.end_headers()
        sent = 0
        try:
            while True:
                with s.lock:
                    while sent >= len(s.upstream):
                        if not s.lock.wait(timeout=10):
                            break
                    pending = s.upstream[sent:]; sent = len(s.upstream)
                if not pending:
                    self.wfile.write(b": keepalive\n\n"); self.wfile.flush(); continue
                for ev in pending:
                    p = ev["payload"]; t = p.get("type")
                    out = {"type": t}
                    if t == "assistant":
                        out["text"] = "".join(b.get("text", "") for b in p.get("message", {}).get("content", [])
                                              if isinstance(b, dict))
                    elif t == "control_request":
                        req = p.get("request", {})
                        out["subtype"] = req.get("subtype")
                        out["request_id"] = p.get("request_id") or req.get("request_id")
                        out["tool_name"] = req.get("tool_name")
                        out["tool_input"] = req.get("tool_input")
                    self.wfile.write(("data: %s\n\n" % json.dumps(out)).encode()); self.wfile.flush()
        except Exception:
            pass

def run_client_face():
    httpd = ThreadingHTTPServer(("127.0.0.1", args.client_port), ClientHandler)
    log("client UI on http://127.0.0.1:%d/" % args.client_port)
    httpd.serve_forever()

if __name__ == "__main__":
    threading.Thread(target=run_client_face, daemon=True).start()
    run_proxy()
