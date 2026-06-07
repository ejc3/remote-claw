"""The MITM proxy: claude is pointed here via HTTPS_PROXY.

For `api.anthropic.com` it terminates TLS with our leaf cert and either
  • intercepts the Remote Control endpoints (we are the relay backend), or
  • passes the request through to the real upstream (inference, oauth, telemetry).
All other hosts are blind-tunnelled untouched.
"""

from __future__ import annotations

import contextlib
import json
import re
import select
import socket
import ssl
import threading
from typing import Any

from . import http_util as hu
from .config import INTERCEPT_PREFIXES, MITM_HOST, Config
from .core import RelayCore, Session
from .log import get

log = get()

_SESS_RE = re.compile(r"^/v1/code/sessions/([^/?]+)(/[^?]*)?")


class MitmProxy:
    def __init__(self, cfg: Config, core: RelayCore, stop: threading.Event):
        self.cfg = cfg
        self.core = core
        self.stop = stop
        self._srv: socket.socket | None = None

        self._srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._srv_ctx.load_cert_chain(cfg.leaf_pem, cfg.leaf_key)
        self._srv_ctx.set_alpn_protocols(["http/1.1"])
        self._up_ctx = ssl.create_default_context()
        self._up_ctx.set_alpn_protocols(["http/1.1"])

    # ---------------- server loop ----------------
    def serve(self) -> None:
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", self.cfg.proxy_port))
        self._srv.listen(128)
        self._srv.settimeout(0.5)
        log.info("MITM proxy on http://127.0.0.1:%d (intercepts %s)", self.cfg.proxy_port, MITM_HOST)
        while not self.stop.is_set():
            try:
                client, _ = self._srv.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            threading.Thread(target=self._safe_client, args=(client,), daemon=True).start()

    def shutdown(self) -> None:
        if self._srv:
            with contextlib.suppress(OSError):
                self._srv.close()

    # ---------------- connection handling ----------------
    def _safe_client(self, client: socket.socket) -> None:
        try:
            self._handle_client(client)
        except Exception as e:  # never let a worker thread crash silently
            log.debug("proxy connection error: %s", e)
            with contextlib.suppress(OSError):
                client.close()

    def _handle_client(self, client: socket.socket) -> None:
        r = hu.recv_headers(client)
        if not r:
            client.close()
            return
        head, _ = r
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        parts = line.split(" ")
        if len(parts) < 2 or parts[0] != "CONNECT":
            client.close()
            return
        host, _, port_s = parts[1].partition(":")
        port = int(port_s or 443)
        if host == MITM_HOST:
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            try:
                tls = self._srv_ctx.wrap_socket(client, server_side=True)
            except ssl.SSLError as e:
                log.debug("client TLS handshake failed: %s", e)
                client.close()
                return
            try:
                self._mitm_conn(tls)
            finally:
                with contextlib.suppress(OSError):
                    tls.close()
        else:
            self._blind_tunnel(client, host, port)

    def _mitm_conn(self, tls: ssl.SSLSocket) -> None:
        r = hu.recv_headers(tls)
        if not r:
            return
        head, rest = r
        method, path, headers = hu.parse_request(head)
        body = hu.read_body(tls, headers, rest)
        clean_path = path.split("?", 1)[0]
        if clean_path.startswith(INTERCEPT_PREFIXES):
            log.debug("intercept %s %s", method, path)
            self._intercept(tls, method, clean_path, body)
        else:
            self._passthrough(tls, method, path, head, body)

    # ---------------- relay endpoints (worker side) ----------------
    def _intercept(self, tls: ssl.SSLSocket, method: str, path: str, body: bytes) -> None:
        try:
            data = json.loads(body) if body else {}
            if not isinstance(data, dict):
                data = {}
        except json.JSONDecodeError:
            return _send_json(tls, {"error": "invalid json"}, "400 Bad Request")

        if path == "/v1/code/triggers":
            return _send_json(tls, {"data": []})

        if path == "/v1/code/sessions" and method == "POST":
            s = self.core.create(data)
            log.info("session created: %s (title=%s)", s.id, s.title)
            return _send_json(tls, {"session": s.session_obj()})

        m = _SESS_RE.match(path)
        if not m:
            return _send_json(tls, {"error": "not found"}, "404 Not Found")
        sid, sub = m.group(1), (m.group(2) or "")
        s = self.core.get(sid)
        if not s:
            return _send_json(tls, {"error": "no such session"}, "404 Not Found")

        if sub == "" and method == "GET":
            return _send_json(tls, {"session": s.session_obj()})
        if sub == "/bridge":
            return _send_json(
                tls,
                {
                    "api_base_url": f"https://{MITM_HOST}",
                    "expires_in": 14400,
                    "worker_epoch": "1",
                    "worker_jwt": "rcw-" + s.id,
                },
            )
        if sub == "/worker" and method == "GET":
            return _send_json(
                tls,
                {
                    "worker": {
                        "session_id": sid,
                        "worker_epoch": str(s.worker_epoch),
                        "worker_status": s.worker_status,
                    }
                },
            )
        if sub == "/worker" and method == "PUT":
            if isinstance(data.get("worker_status"), str):
                s.worker_status = data["worker_status"]
            return _send_json(tls, {})
        if sub == "/worker/heartbeat":
            return _send_json(tls, {})
        if sub == "/worker/events/delivery":
            for upd in data.get("updates", []):
                if upd.get("event_id"):
                    s.ack(upd["event_id"])
            return _send_json(tls, {})
        if sub == "/worker/events" and method == "POST":
            for ev in data.get("events", []):
                payload = ev.get("payload", {})
                s.push_upstream(payload)
                if payload.get("type") == "assistant":
                    txt = _assistant_text(payload)
                    if txt:
                        log.info("⇠ assistant (%s): %s", s.id[:12], _clip(txt))
            return _send_json(tls, {})
        if sub == "/worker/events/stream" and method == "GET":
            return self._stream_worker(tls, s)

        return _send_json(tls, {})

    def _stream_worker(self, tls: ssl.SSLSocket, s: Session) -> None:
        tls.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
            b"Cache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )
        s.push_initialize()
        log.info("worker SSE connected: %s", s.id)
        try:
            for ev in s.follow_downstream(self.stop.is_set):
                if ev is None:
                    tls.sendall(b":keepalive\n\n")
                    continue
                frame = (
                    f"event: client_event\nid: {ev.sequence_num}\ndata: {json.dumps(ev.wire())}\n\n"
                ).encode()
                tls.sendall(frame)
                log.debug("⇢ worker: %s/%s", ev.event_type, ev.payload.get("type", ""))
        except (OSError, ssl.SSLError):
            log.info("worker SSE disconnected: %s", s.id)

    # ---------------- passthrough / tunnel ----------------
    def _passthrough(self, tls: ssl.SSLSocket, method: str, path: str, head: bytes, body: bytes) -> None:
        hdrs_text = head.decode("latin1").split("\r\n", 1)[1].rstrip("\r\n")
        # strip accept-encoding so we never have to gunzip; force close framing
        lines = hu.headers_without(
            hdrs_text, ("connection", "proxy-connection", "keep-alive", "accept-encoding")
        )
        lines.append("Connection: close")
        req = (f"{method} {path} HTTP/1.1\r\n" + "\r\n".join(lines) + "\r\n\r\n").encode("latin1")
        try:
            raw = socket.create_connection((MITM_HOST, 443), timeout=300)
            up = self._up_ctx.wrap_socket(raw, server_hostname=MITM_HOST)
        except OSError as e:
            log.debug("upstream connect failed: %s", e)
            return _send_status(tls, "502 Bad Gateway")
        try:
            up.sendall(req + body)
            while True:
                c = up.recv(65536)
                if not c:
                    break
                tls.sendall(c)
        except (OSError, ssl.SSLError):
            pass
        finally:
            up.close()

    def _blind_tunnel(self, client: socket.socket, host: str, port: int) -> None:
        try:
            up = socket.create_connection((host, port), timeout=30)
        except OSError:
            client.close()
            return
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        socks = [client, up]
        try:
            while not self.stop.is_set():
                r, _, _ = select.select(socks, [], [], 30)
                if not r:
                    continue
                for sx in r:
                    data = sx.recv(65536)
                    if not data:
                        return
                    (up if sx is client else client).sendall(data)
        except OSError:
            pass
        finally:
            client.close()
            up.close()


def _send_json(tls: ssl.SSLSocket, obj: Any, status: str = "200 OK") -> None:
    body = json.dumps(obj).encode()
    tls.sendall(
        (
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        ).encode()
        + body
    )


def _send_status(tls: ssl.SSLSocket, status: str) -> None:
    tls.sendall(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())


def _assistant_text(payload: dict[str, Any]) -> str:
    return "".join(
        b.get("text", "")
        for b in payload.get("message", {}).get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )


def _clip(s: str, n: int = 80) -> str:
    s = s.replace("\n", " ")
    return s if len(s) <= n else s[:n] + "…"
