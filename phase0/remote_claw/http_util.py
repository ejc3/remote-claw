"""Minimal HTTP/1.1 helpers for the MITM proxy (stdlib sockets, no frameworks)."""

from __future__ import annotations

import socket

MAX_HEADER = 256 * 1024
MAX_BODY = 64 * 1024 * 1024  # 64 MiB safety cap on intercepted request bodies


def recv_headers(sock: socket.socket) -> tuple[bytes, bytes] | None:
    """Read until end-of-headers. Returns (header_bytes, leftover_body) or None."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            return None
        buf += chunk
        if len(buf) > MAX_HEADER:
            raise ValueError("request headers too large")
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head + b"\r\n\r\n", rest


def parse_request(head: bytes) -> tuple[str, str, dict[str, str]]:
    """Parse a request line + headers into (method, path, headers-lowercased)."""
    text = head.decode("latin1")
    line, _, hdrs = text.partition("\r\n")
    headers: dict[str, str] = {}
    for ln in hdrs.split("\r\n"):
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    parts = line.split(" ")
    method = parts[0] if parts else ""
    path = parts[1] if len(parts) > 1 else ""
    return method, path, headers


def read_body(sock: socket.socket, headers: dict[str, str], already: bytes) -> bytes:
    """Read a request body per Content-Length or chunked encoding (size-capped)."""
    if "content-length" in headers:
        n = int(headers["content-length"])
        if n > MAX_BODY:
            raise ValueError("request body too large")
        body = already
        while len(body) < n:
            c = sock.recv(min(65536, n - len(body)))
            if not c:
                break
            body += c
        return body
    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = already
        while b"0\r\n\r\n" not in body and len(body) < MAX_BODY:
            c = sock.recv(65536)
            if not c:
                break
            body += c
        return dechunk(body)
    return already


def dechunk(data: bytes) -> bytes:
    """Decode HTTP chunked transfer-encoding to a flat body."""
    out = b""
    b = data
    while b"\r\n" in b:
        size_line, b = b.split(b"\r\n", 1)
        try:
            n = int(size_line.split(b";")[0], 16)
        except ValueError:
            break
        if n == 0:
            break
        out += b[:n]
        b = b[n + 2 :]
    return out


def headers_without(hdrs_text: str, drop: tuple[str, ...]) -> list[str]:
    """Return header lines minus the named (case-insensitive) headers."""
    drop_l = {d.lower() for d in drop}
    out = []
    for ln in hdrs_text.split("\r\n"):
        if not ln:
            continue
        if ln.split(":", 1)[0].strip().lower() in drop_l:
            continue
        out.append(ln)
    return out
