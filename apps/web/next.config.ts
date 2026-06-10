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
};

// withWorkflow wires the Workflow DevKit compiler into the Next build so "use workflow" /
// "use step" functions become durable runs on Vercel Workflows.
export default withWorkflow(nextConfig);
