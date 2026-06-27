// IMPERSONATOR MITM — the feasibility spike for "zero Anthropic, Bedrock inference".
// It NEVER connects to api.anthropic.com. It TLS-terminates that host and SYNTHESIZES every
// control-plane response, and serves /v1/messages from a LOCAL backend (here: a canned echo that
// proves the bytes came from us, not Anthropic). If `claude --print` returns our canned word, the
// central claim holds: claude is satisfied by a fully fabricated Anthropic side + a non-Anthropic
// inference backend. Swapping the canned backend for a Bedrock translator is the only remaining step.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { connect as netConnect } from "node:net";
import { TLSSocket } from "node:tls";
import { join } from "node:path";

const HOST = "api.anthropic.com";
const DIR = process.env.IMP_DIR || "/tmp/claude-1000/-home-ubuntu-remote-claw/scratchpad/imp";
const LOG = join(DIR, "calls.jsonl");
const CANNED_WORD = process.env.IMP_WORD || "BEDROCKECHO";
mkdirSync(DIR, { recursive: true });
writeFileSync(LOG, "");

function ensureCerts() {
  const caPem = join(DIR, "ca.pem");
  if (!existsSync(caPem) || !existsSync(join(DIR, "leaf.pem"))) {
    const run = (...a) => execFileSync("openssl", a, { cwd: DIR, stdio: "ignore" });
    run("genrsa", "-out", "ca.key", "2048");
    run("req","-x509","-new","-nodes","-key","ca.key","-sha256","-days","365","-out","ca.pem","-subj","/CN=imp-CA");
    run("genrsa", "-out", "leaf.key", "2048");
    run("req","-new","-key","leaf.key","-out","leaf.csr","-subj",`/CN=${HOST}`);
    writeFileSync(join(DIR,"leaf.ext"),`subjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`);
    run("x509","-req","-in","leaf.csr","-CA","ca.pem","-CAkey","ca.key","-CAcreateserial","-out","leaf.pem","-days","365","-sha256","-extfile","leaf.ext");
  }
  return { caPem, leaf: { cert: readFileSync(join(DIR,"leaf.pem")), key: readFileSync(join(DIR,"leaf.key")) } };
}
const { caPem, leaf } = ensureCerts();
const log = (e) => appendFileSync(LOG, JSON.stringify(e) + "\n");
const readBody = (req) => new Promise((r) => { const c=[]; req.on("data",x=>c.push(x)); req.on("end",()=>r(Buffer.concat(c))); req.on("error",()=>r(Buffer.concat(c))); });

// ---- synthesized control-plane responses (templates from a real --print capture) ----
const BOOTSTRAP = {
  client_data: {},
  additional_model_options: [],
  additional_model_costs: null,
  oauth_account: {
    account_uuid: "00000000-0000-0000-0000-000000000000",
    account_email: "bedrock-user@example.com",
    organization_uuid: "11111111-1111-1111-1111-111111111111",
    organization_name: "Bedrock Org",
    organization_type: "claude_max",
    organization_rate_limit_tier: "default_claude_max_20x",
    user_rate_limit_tier: null, seat_tier: null,
  },
  model_access: null, org_model_default: null, cwk_cfg_key: null, auto_compact_windows: null,
};

function json(res, obj, status = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": b.length });
  res.end(b);
}

// A minimal, VALID Anthropic streaming response that says CANNED_WORD. This stands in for the
// Bedrock translator's output (Bedrock emits these very same events, just wrapped in eventstream).
function serveCannedMessages(reqBody, res) {
  let model = "claude-opus-4-8";
  try { model = JSON.parse(reqBody.toString("utf8")).model || model; } catch {}
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = "msg_imp_0000000000";
  ev("message_start", { type:"message_start", message:{ id, type:"message", role:"assistant", model, content:[], stop_reason:null, stop_sequence:null, usage:{ input_tokens:10, output_tokens:1 } } });
  ev("content_block_start", { type:"content_block_start", index:0, content_block:{ type:"text", text:"" } });
  ev("ping", { type:"ping" });
  ev("content_block_delta", { type:"content_block_delta", index:0, delta:{ type:"text_delta", text:CANNED_WORD } });
  ev("content_block_stop", { type:"content_block_stop", index:0 });
  ev("message_delta", { type:"message_delta", delta:{ stop_reason:"end_turn", stop_sequence:null }, usage:{ output_tokens:3 } });
  ev("message_stop", { type:"message_stop" });
  res.end();
}

const inner = new Server(async (req, res) => {
  const rawUrl = req.url ?? "";
  const path = rawUrl.split("?", 1)[0] ?? "";
  const body = await readBody(req);
  log({ method: req.method, path, synthesized: true });

  if (path === "/v1/messages" && req.method === "POST") return serveCannedMessages(body, res);
  if (path === "/v1/messages/count_tokens") return json(res, { input_tokens: 10 });
  if (path === "/api/claude_cli/bootstrap") return json(res, BOOTSTRAP);
  if (path === "/api/claude_code_penguin_mode") return json(res, { enabled: false, disabled_reason: null });
  if (path === "/v1/mcp_servers") return json(res, { data: [] });
  if (path.startsWith("/mcp-registry/")) return json(res, { servers: [] });
  if (path === "/v1/models") return json(res, { data: [{ type:"model", id:"claude-opus-4-8", display_name:"Opus" }], has_more:false });
  // Telemetry / anything else under the host: 200-stub so nothing falls through to real Anthropic.
  return json(res, {});
});

const proxy = new Server((_q, s) => s.writeHead(400).end("CONNECT only"));
proxy.on("connect", (req, socket, head) => {
  const a = req.url ?? ""; const i = a.lastIndexOf(":");
  const host = i === -1 ? a : a.slice(0, i); const port = i === -1 ? 443 : Number.parseInt(a.slice(i+1)||"443",10);
  if (host === HOST) {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    const tls = new TLSSocket(socket, { isServer:true, cert:leaf.cert, key:leaf.key, ALPNProtocols:["http/1.1"] });
    tls.on("error", () => {});
    inner.emit("connection", tls);
  } else {
    // Blind-tunnel non-Anthropic hosts (e.g. statsig, sentry) so claude's other egress still works.
    const up = netConnect(port, host, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up); });
    const kill = () => { up.destroy(); socket.destroy(); }; up.on("error", kill); socket.on("error", kill);
  }
});
proxy.listen(0, "127.0.0.1", () => {
  const port = proxy.address().port;
  writeFileSync(join(DIR, "port"), String(port));
  writeFileSync(join(DIR, "ca-path"), caPem);
  console.log(`impersonator listening 127.0.0.1:${port}; CA ${caPem}; word ${CANNED_WORD}`);
});
