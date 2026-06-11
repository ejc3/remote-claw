import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // clawsec is a workspace package that ships raw TypeScript (exports ./src/index.ts, with `.js`
  // import specifiers per verbatimModuleSyntax) so the CLI and tests consume its source directly.
  // Two settings make Next bundle it: transpilePackages runs it through Next's compiler (else
  // Turbopack rejects the `.ts` entry in node_modules), and extensionAlias maps its `.js` specifiers
  // back to the `.ts` sources (else `./wire.js` etc. don't resolve).
  transpilePackages: ["@remote-claw/clawsec", "@remote-claw/cli"],
  // @temporalio/* wrap a gRPC/protobuf core (and, for the worker, a native Rust addon) that webpack
  // mangles (the "Critical dependency" warning) — bundling breaks the connection (getSystemInfo fails
  // with undefined status) and can't bundle the .node binary. Keep them external so the Node runtime
  // loads them from node_modules. @temporalio/client → the TemporalBackend (lib/broker/temporal.ts);
  // @temporalio/worker → the keep-warm drain route (app/api/temporal/drain). The route runs the
  // worker from a PRE-BUILT workflow bundle (temporal/workflow-bundle.generated.ts), so the function
  // needs no @temporalio/workflow at runtime and no in-function bundler. Each is loaded only when its
  // code path runs.
  serverExternalPackages: ["@temporalio/client", "@temporalio/worker"],
  experimental: {
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  // Security headers — defense-in-depth for the viewer, which holds a live RC **pass** (a credential
  // that can read and steer the machine's sessions, kept in `sessionStorage` so it survives a refresh
  // per #56/#57, and client-only per the zero-knowledge model). Today nothing can exfiltrate it: the
  // transcript/tool/permission renderers build pure React nodes (auto-escaped), with no
  // `dangerouslySetInnerHTML`, no untrusted `href`/`src`, no `eval` (audited). The CSP is belt-and-braces
  // against a FUTURE injection sink.
  //
  // The CSP's value is its **exfiltration-blocking** directives — `default-src`/`connect-src`/`img-src`/
  // `font-src`/`form-action`/`base-uri` are all same-origin and `object-src`/`frame-ancestors` are
  // `none`, so even an injected script can't fetch/beacon/POST the pass to another origin, hijack the
  // base URI, or be framed. `script-src` keeps `'self'` (no external script origins) but must allow
  // `'unsafe-inline'`: Next emits inline hydration scripts, and a nonce/`strict-dynamic` policy can't be
  // used because Next 16's `proxy`/`middleware` does not propagate a per-request nonce to those scripts
  // (verified — the nonce never lands on the <script> tags, so `strict-dynamic` blocks all hydration).
  // A nonce-based `script-src` is tracked as future work pending that framework limitation.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

// withWorkflow wires the Workflow DevKit compiler into the Next build so "use workflow" /
// "use step" functions become durable runs on Vercel Workflows.
export default withWorkflow(nextConfig);
