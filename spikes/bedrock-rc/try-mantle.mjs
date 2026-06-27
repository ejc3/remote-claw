// Probe the native bedrock-mantle Anthropic Messages endpoint with instance-role SigV4.
import aws4 from "aws4";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

function imds(path, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { "X-aws-ec2-metadata-token": token } : { "X-aws-ec2-metadata-token-ttl-seconds": "60" };
    const req = httpRequest({ host: "169.254.169.254", path, method: token ? "GET" : "PUT", headers, timeout: 3000 }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("imds timeout"))); req.end();
  });
}

async function creds() {
  const token = await imds("/latest/api/token");
  const role = (await imds("/latest/meta-data/iam/security-credentials/", token)).trim();
  const c = JSON.parse(await imds(`/latest/meta-data/iam/security-credentials/${role}`, token));
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, role };
}

function call(region, model, cred) {
  const host = `bedrock-mantle.${region}.api.aws`;
  const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with exactly one word: PINEAPPLE" }] });
  const opts = aws4.sign(
    { host, path: "/anthropic/v1/messages", service: "bedrock-mantle", region, method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body },
    cred,
  );
  return new Promise((resolve) => {
    const req = httpsRequest({ host, path: opts.path, method: "POST", headers: opts.headers, timeout: 20000 }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b.slice(0, 500) }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "ERR " + e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.write(body); req.end();
  });
}

const cred = await creds();
console.log("role:", cred.role, "| have sessionToken:", Boolean(cred.sessionToken));
for (const region of ["us-east-1", "us-west-2", "us-east-2", "us-west-1"]) {
  for (const model of ["anthropic.claude-opus-4-8", "us.anthropic.claude-opus-4-1-20250805-v1:0"]) {
    const r = await call(region, model, cred);
    console.log(`\n[${region}] ${model} -> HTTP ${r.status}\n  ${r.body.replace(/\n/g, "\n  ")}`);
  }
}
