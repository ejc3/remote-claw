// Discovery MITM: logs EVERY api.anthropic.com request+response (method/path/status/bodies),
// passes through to the real upstream, blind-tunnels other hosts. Auth headers are REDACTED.
// Purpose: inventory exactly what `claude` calls at startup/inference so we know what a
// "zero-Anthropic + Bedrock-inference" MITM must synthesize vs translate. Standalone, no deps.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { TLSSocket } from "node:tls";
import { join } from "node:path";

const HOST = "api.anthropic.com";
const DIR = process.env.DISCOVER_DIR || "/tmp/claude-1000/-home-ubuntu-remote-claw/scratchpad/discover";
const LOG = join(DIR, "calls.jsonl");
const BODY_CAP = 64 * 1024;
mkdirSync(DIR, { recursive: true });
writeFileSync(LOG, "");

// --- certs (CA + leaf for api.anthropic.com) ---
function ensureCerts() {
  const caPem = join(DIR, "ca.pem"), caKey = join(DIR, "ca.key");
  const leafPem = join(DIR, "leaf.pem"), leafKey = join(DIR, "leaf.key");
  if (!existsSync(caPem) || !existsSync(leafPem)) {
    const run = (...a) => execFileSync("openssl", a, { cwd: DIR, stdio: "ignore" });
    run("genrsa", "-out", "ca.key", "2048");
    run("req","-x509","-new","-nodes","-key","ca.key","-sha256","-days","365","-out","ca.pem","-subj","/CN=discover-CA");
    run("genrsa", "-out", "leaf.key", "2048");
    run("req","-new","-key","leaf.key","-out","leaf.csr","-subj",`/CN=${HOST}`);
    writeFileSync(join(DIR,"leaf.ext"),`subjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`);
    run("x509","-req","-in","leaf.csr","-CA","ca.pem","-CAkey","ca.key","-CAcreateserial","-out","leaf.pem","-days","365","-sha256","-extfile","leaf.ext");
  }
  return { caPem, leaf: { cert: readFileSync(leafPem), key: readFileSync(leafKey) } };
}
const { caPem, leaf } = ensureCerts();

const REDACT = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"]);
function safeHeaders(h) {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k] = REDACT.has(k.toLowerCase()) ? "<redacted>" : v;
  return o;
}
function logEvent(e) { appendFileSync(LOG, JSON.stringify(e) + "\n"); }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

const inner = new Server(async (req, res) => {
  const rawUrl = req.url ?? "";
  const path = rawUrl.split("?", 1)[0] ?? "";
  const reqBody = await readBody(req);
  const startedAt = process.hrtime.bigint();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (["connection","proxy-connection","keep-alive","transfer-encoding","te","trailer","upgrade","content-length","accept-encoding"].includes(lk)) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["content-length"] = String(reqBody.length);
  headers["accept-encoding"] = "identity";

  const up = httpsRequest({ host: HOST, port: 443, method: req.method, path: rawUrl, headers, servername: HOST }, (uo) => {
    res.writeHead(uo.statusCode ?? 502, uo.headers);
    const ct = String(uo.headers["content-type"] ?? "");
    const isSse = ct.includes("text/event-stream");
    const chunks = []; let kept = 0;
    uo.on("data", (c) => { if (kept < BODY_CAP) { chunks.push(c); kept += c.length; } });
    uo.pipe(res);
    uo.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      logEvent({
        t: Number(process.hrtime.bigint() - startedAt) / 1e6,
        method: req.method, path, query: rawUrl.includes("?"),
        status: uo.statusCode, content_type: ct, sse: isSse,
        req_headers: safeHeaders(req.headers),
        req_body: reqBody.length ? reqBody.toString("utf8").slice(0, BODY_CAP) : "",
        resp_body: isSse ? body.slice(0, 4096) : (kept >= BODY_CAP ? body + "…(truncated)" : body),
      });
    });
  });
  up.on("error", (err) => {
    logEvent({ method: req.method, path, error: err.message });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  if (reqBody.length) up.write(reqBody);
  up.end();
});

const proxy = new Server((_req, res) => res.writeHead(400).end("CONNECT only"));
proxy.on("connect", (req, socket, head) => {
  const authority = req.url ?? "";
  const idx = authority.lastIndexOf(":");
  const host = idx === -1 ? authority : authority.slice(0, idx);
  const port = idx === -1 ? 443 : Number.parseInt(authority.slice(idx + 1) || "443", 10);
  if (host === HOST) {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    const tls = new TLSSocket(socket, { isServer: true, cert: leaf.cert, key: leaf.key, ALPNProtocols: ["http/1.1"] });
    tls.on("error", () => {});
    inner.emit("connection", tls);
  } else {
    const upstream = netConnect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const kill = () => { upstream.destroy(); socket.destroy(); };
    upstream.on("error", kill); socket.on("error", kill);
  }
});

proxy.listen(0, "127.0.0.1", () => {
  const port = proxy.address().port;
  writeFileSync(join(DIR, "port"), String(port));
  writeFileSync(join(DIR, "ca-path"), caPem);
  console.log(`discover-mitm listening 127.0.0.1:${port}`);
  console.log(`CA: ${caPem}`);
  console.log(`LOG: ${LOG}`);
});
