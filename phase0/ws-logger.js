#!/usr/bin/env node
// Phase 0 — zero-dependency WebSocket logger.
//
// Stands up a minimal RFC 6455 WebSocket *server* and dumps every frame
// verbatim (raw hex + decoded text, NDJSON-split) to stdout AND a capture file.
// Purpose: capture the REAL CCRv1 handshake from `claude --remote-control
// --sdk-url ws://localhost:PORT`. See docs/remote-control-research.md §3-§4, §9.
//
// Usage:
//   node ws-logger.js [--port 8787] [--send-init] [--init-file path.json]
//
// Flags:
//   --port N        listen port (default 8787)
//   --send-init     after the client connects, send a control_request{initialize}
//                   to try to elicit the success response (capture the full
//                   handshake). Off by default = pure passive capture first.
//   --init-file F   JSON file whose contents are sent as the initialize payload
//                   (overrides the built-in minimal default).
//
// Everything is logged; nothing is interpreted. Treat output as raw evidence.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---- args ----
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const PORT = parseInt(opt("--port", "8787"), 10);
const SEND_INIT = flag("--send-init");
const INIT_FILE = opt("--init-file", null);

// ---- capture file ----
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const capDir = path.join(__dirname, "captures");
fs.mkdirSync(capDir, { recursive: true });
const capPath = path.join(capDir, `capture-${stamp}.log`);
const cap = fs.createWriteStream(capPath, { flags: "a" });

function log(...parts) {
  const line = parts.join(" ");
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  process.stdout.write(out + "\n");
  cap.write(out + "\n");
}
function logBlock(label, body) {
  log(`----- ${label} -----`);
  for (const ln of String(body).split("\n")) {
    process.stdout.write("    " + ln + "\n");
    cap.write("    " + ln + "\n");
  }
}

// ---- WS frame encoder (server->client: NOT masked) ----
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

// ---- WS frame decoder (client->server: masked) ----
// Returns {frames:[{opcode, payload(Buffer)}], rest:Buffer}
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4); p += 4;
    }
    if (p + len > buf.length) break; // incomplete; wait for more
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
      payload = unmasked;
    }
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function prettyNdjson(text) {
  // CCRv1 = JSON.stringify(obj)+"\n", possibly multiple per frame.
  const lines = text.split("\n").filter((l) => l.length > 0);
  const out = [];
  for (const ln of lines) {
    try {
      out.push(JSON.stringify(JSON.parse(ln), null, 2));
    } catch {
      out.push("(non-JSON line) " + ln);
    }
  }
  return out.join("\n");
}

// ---- HTTP server + upgrade ----
const server = http.createServer((req, res) => {
  // Non-WS HTTP hit — log it (could be a health check / wrong transport).
  log(`HTTP ${req.method} ${req.url} (non-upgrade request)`);
  logBlock("HTTP headers", JSON.stringify(req.headers, null, 2));
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("Upgrade Required: this is a WebSocket logger\n");
});

server.on("upgrade", (req, socket) => {
  log("=== WEBSOCKET UPGRADE ===");
  log(`${req.method} ${req.url} HTTP/${req.httpVersion}`);
  logBlock("Upgrade request headers", JSON.stringify(req.headers, null, 2));

  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  const respHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  // Echo a requested subprotocol if present (log it; some protocols require it).
  const subproto = req.headers["sec-websocket-protocol"];
  if (subproto) {
    const first = subproto.split(",")[0].trim();
    respHeaders.push(`Sec-WebSocket-Protocol: ${first}`);
    log(`Client requested subprotocol(s): ${subproto} -> echoing "${first}"`);
  }
  socket.write(respHeaders.join("\r\n") + "\r\n\r\n");
  log("Sent 101 Switching Protocols. WebSocket open.");

  let buffer = Buffer.alloc(0);

  function send(obj) {
    const text = JSON.stringify(obj) + "\n";
    socket.write(encodeFrame(text, 0x1));
    logBlock("SENT (server->claude)", prettyNdjson(text));
  }

  if (SEND_INIT) {
    let initReq;
    if (INIT_FILE) {
      initReq = JSON.parse(fs.readFileSync(INIT_FILE, "utf8"));
    } else {
      // Minimal best-guess initialize per research §3.6/§4.2. Verify shape!
      initReq = {
        type: "control_request",
        request_id: "req_init_1",
        request: { subtype: "initialize" },
      };
    }
    // Slight delay so the client finishes its own setup first.
    setTimeout(() => send(initReq), 300);
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const f of frames) {
      const opName =
        { 0x0: "cont", 0x1: "text", 0x2: "binary", 0x8: "close", 0x9: "ping", 0xa: "pong" }[
          f.opcode
        ] || `op${f.opcode}`;
      if (f.opcode === 0x1) {
        const text = f.payload.toString("utf8");
        log(`RECV text frame (${f.payload.length} bytes, fin=${f.fin})`);
        logBlock("RECV (claude->server) decoded", prettyNdjson(text));
      } else if (f.opcode === 0x8) {
        log(`RECV close frame (${f.payload.length} bytes): ${f.payload.toString("hex")}`);
        socket.end();
      } else if (f.opcode === 0x9) {
        log("RECV ping -> sending pong");
        socket.write(encodeFrame(f.payload, 0xa));
      } else if (f.opcode === 0xa) {
        log("RECV pong");
      } else {
        log(`RECV ${opName} frame (${f.payload.length} bytes): ${f.payload.toString("hex").slice(0, 200)}`);
      }
    }
  });

  socket.on("close", () => log("=== socket closed ==="));
  socket.on("error", (e) => log("socket error: " + e.message));
});

server.listen(PORT, "127.0.0.1", () => {
  log(`ws-logger listening on ws://127.0.0.1:${PORT}`);
  log(`capture file: ${capPath}`);
  log(`send-init: ${SEND_INIT}${INIT_FILE ? " (file: " + INIT_FILE + ")" : ""}`);
});
