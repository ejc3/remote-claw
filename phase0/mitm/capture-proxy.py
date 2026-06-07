#!/usr/bin/env python3
"""Phase 0 MITM capture proxy (stdlib only).

A forward HTTP proxy you point ONE claude process at via HTTPS_PROXY. It
MITM-decrypts only `api.anthropic.com` (using the pre-generated leaf cert) and
logs the Remote Control HTTP traffic verbatim; every other host is blind-tunneled
untouched. Inference (`/v1/messages`) and auth are passed through to the real
upstream so the session keeps working.

Scope: per-process (env var), no /etc/hosts, no sudo, no effect on other claude
sessions on this box.

Run:
  python3 capture-proxy.py --port 8888
Point claude at it:
  HTTPS_PROXY=http://127.0.0.1:8888 \
  NODE_EXTRA_CA_CERTS=.../certs/ca.pem \
  claude --remote-control phase0 --verbose
"""

import argparse
import contextlib
import datetime
import os
import select
import socket
import ssl
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
CERTS = os.path.join(HERE, "certs")
MITM_HOST = "api.anthropic.com"

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8888)
ap.add_argument(
    "--logfile",
    default=os.path.join(
        HERE, "captures", "mitm-" + datetime.datetime.now().strftime("%Y%m%dT%H%M%S") + ".log"
    ),
)
ap.add_argument(
    "--log-all-bodies", action="store_true", help="log bodies for ALL paths (default: only /v1/code/*)"
)
args = ap.parse_args()
os.makedirs(os.path.dirname(args.logfile), exist_ok=True)
_loglock = threading.Lock()
_logf = open(args.logfile, "a", buffering=1)


def log(msg):
    line = f"[{datetime.datetime.now().isoformat()}] {msg}"
    with _loglock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
        _logf.write(line + "\n")


def logblock(label, body):
    with _loglock:
        for sink in (sys.stdout, _logf):
            sink.write(f"----- {label} -----\n")
            for ln in body.split("\n"):
                sink.write("    " + ln + "\n")
        sys.stdout.flush()


# ---- server-side TLS ctx (presents our leaf to claude) ----
srv_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
srv_ctx.load_cert_chain(os.path.join(CERTS, "leaf.pem"), os.path.join(CERTS, "leaf.key"))
srv_ctx.set_alpn_protocols(["http/1.1"])  # force HTTP/1.1 (avoid h2 MITM)

# ---- client-side TLS ctx (we -> real upstream, verified) ----
up_ctx = ssl.create_default_context()
up_ctx.set_alpn_protocols(["http/1.1"])

REDACT = ("authorization", "cookie", "x-api-key", "anthropic-")


def dump_headers(raw_headers):
    out = []
    for ln in raw_headers.split("\r\n"):
        k = ln.split(":", 1)[0].lower().strip()
        if any(k.startswith(p) for p in REDACT) and ":" in ln:
            out.append(ln.split(":", 1)[0] + ": <redacted>")
        else:
            out.append(ln)
    return "\n".join(out)


def recv_headers(sock):
    """Read until end of HTTP headers. Returns (head_bytes, leftover_body_bytes) or None."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > 1024 * 1024:
            break
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head + b"\r\n\r\n", rest


def parse_headers(head_bytes):
    text = head_bytes.decode("latin1")
    line, _, hdrs = text.partition("\r\n")
    h = {}
    for ln in hdrs.split("\r\n"):
        if ":" in ln:
            k, v = ln.split(":", 1)
            h[k.strip().lower()] = v.strip()
    return line.strip(), hdrs.rstrip("\r\n"), h


def read_body(sock, headers, already):
    """Read a request body given content-length / chunked. Returns full body bytes."""
    if "content-length" in headers:
        n = int(headers["content-length"])
        body = already
        while len(body) < n:
            c = sock.recv(min(65536, n - len(body)))
            if not c:
                break
            body += c
        return body
    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = already
        while b"0\r\n\r\n" not in body:
            c = sock.recv(65536)
            if not c:
                break
            body += c
        return body
    return already  # no body


def force_close(hdrs, drop=()):
    skip = {"connection", "proxy-connection", "keep-alive"} | set(drop)
    keep = [ln for ln in hdrs.split("\r\n") if ln and ln.split(":", 1)[0].lower().strip() not in skip]
    keep.append("Connection: close")
    return "\r\n".join(keep)


class Dechunker:
    """Incrementally decode HTTP chunked transfer-encoding for logging."""

    def __init__(self):
        self.buf = b""
        self.done = False

    def feed(self, data):
        self.buf += data
        out = b""
        while True:
            if b"\r\n" not in self.buf:
                break
            size_line, rest = self.buf.split(b"\r\n", 1)
            try:
                n = int(size_line.strip().split(b";")[0], 16)
            except ValueError:
                break
            if n == 0:
                self.done = True
                break
            if len(rest) < n + 2:
                break
            out += rest[:n]
            self.buf = rest[n + 2 :]
        return out


def handle_mitm(client_tls, conn_id):
    """One request/response over a MITM'd TLS connection, then close."""
    r = recv_headers(client_tls)
    if not r:
        return
    head, rest = r
    reqline, hdrs, H = parse_headers(head)
    method, path = (reqline.split(" ") + ["", ""])[:2]
    body = read_body(client_tls, H, rest)
    is_rc = "/v1/code/" in path
    want_body = is_rc or args.log_all_bodies

    log(
        "REQ #%d %s %s://%s%s (host=%s, len=%d)"
        % (conn_id, method, "https", MITM_HOST, path, H.get("host", ""), len(body))
    )
    logblock("REQ headers #%d" % conn_id, dump_headers(hdrs))
    if want_body and body:
        try:
            logblock("REQ body #%d" % conn_id, body.decode("utf-8"))
        except Exception:
            logblock("REQ body #%d (bytes)" % conn_id, repr(body[:4000]))

    # connect to real upstream
    raw = socket.create_connection((MITM_HOST, 443), timeout=300)
    up = up_ctx.wrap_socket(raw, server_hostname=MITM_HOST)
    # strip accept-encoding → upstream replies identity (no gzip) so logs are readable
    new_head = (reqline + "\r\n" + force_close(hdrs, drop=("accept-encoding",)) + "\r\n\r\n").encode("latin1")
    up.sendall(new_head + body)

    # read response head
    rr = recv_headers(up)
    if not rr:
        up.close()
        return
    rhead, rrest = rr
    statusline, rhdrs, RH = parse_headers(rhead)
    is_sse = "text/event-stream" in RH.get("content-type", "")
    is_chunked = RH.get("transfer-encoding", "").lower() == "chunked"
    log(
        "RESP #%d %s  (%s, ct=%s%s)"
        % (conn_id, statusline, path, RH.get("content-type", ""), ", SSE" if is_sse else "")
    )
    logblock("RESP headers #%d" % conn_id, dump_headers(rhdrs))

    client_tls.sendall((statusline + "\r\n" + force_close(rhdrs) + "\r\n\r\n").encode("latin1"))

    dec = Dechunker() if is_chunked else None
    collected = bytearray()
    sse_buf = b""

    def decode(chunk):
        return dec.feed(chunk) if dec else chunk

    if rrest:
        client_tls.sendall(rrest)
        if want_body or is_sse:
            collected += decode(rrest)
    while True:
        try:
            c = up.recv(65536)
        except Exception:
            break
        if not c:
            break
        client_tls.sendall(c)
        if want_body or is_sse:
            d = decode(c)
            if is_sse and d:
                # log each SSE event (delimited by blank line) live
                sse_buf += d
                while b"\n\n" in sse_buf:
                    evt, sse_buf = sse_buf.split(b"\n\n", 1)
                    logblock(
                        "SSE EVENT #%d (%s)" % (conn_id, path.split("/")[-1]), evt.decode("utf-8", "replace")
                    )
            elif want_body:
                collected += d
    up.close()
    if is_sse and sse_buf.strip():
        logblock("SSE TAIL #%d" % conn_id, sse_buf.decode("utf-8", "replace"))
    if want_body and not is_sse and collected:
        try:
            logblock("RESP body #%d" % conn_id, bytes(collected).decode("utf-8"))
        except Exception:
            logblock("RESP body #%d (bytes)" % conn_id, repr(bytes(collected)[:4000]))


def blind_tunnel(client, host, port):
    try:
        up = socket.create_connection((host, port), timeout=30)
    except Exception as e:
        log(f"tunnel connect failed {host}:{port} {e}")
        client.close()
        return
    client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    socks = [client, up]
    try:
        while True:
            r, _, _ = select.select(socks, [], [], 60)
            if not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (up if s is client else client).sendall(data)
    except Exception:
        pass
    finally:
        client.close()
        up.close()


_counter = [0]


def handle(client):
    try:
        r = recv_headers(client)
        if not r:
            client.close()
            return
        head, rest = r
        reqline = head.split(b"\r\n", 1)[0].decode("latin1")
        parts = reqline.split(" ")
        if parts[0] != "CONNECT":
            log(f"non-CONNECT request ignored: {reqline}")
            client.close()
            return
        hostport = parts[1]
        host, _, port = hostport.partition(":")
        port = int(port or 443)
        if host == MITM_HOST:
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            try:
                tls = srv_ctx.wrap_socket(client, server_side=True)
            except Exception as e:
                log(f"TLS handshake with client failed: {e}")
                client.close()
                return
            _counter[0] += 1
            cid = _counter[0]
            try:
                handle_mitm(tls, cid)
            except Exception as e:
                log("mitm error #%d: %s" % (cid, e))
            finally:
                with contextlib.suppress(Exception):
                    tls.close()
        else:
            blind_tunnel(client, host, port)
    except Exception as e:
        log(f"handle error: {e}")
        with contextlib.suppress(Exception):
            client.close()


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", args.port))
    srv.listen(128)
    log("capture-proxy on http://127.0.0.1:%d  MITM=%s  log=%s" % (args.port, MITM_HOST, args.logfile))
    while True:
        c, _ = srv.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()


if __name__ == "__main__":
    main()
