import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // clawsec is a workspace package that ships raw TypeScript (exports ./src/index.ts, with `.js`
  // import specifiers per verbatimModuleSyntax) so the CLI and tests consume its source directly.
  // Two settings make Next bundle it: transpilePackages runs it through Next's compiler (else
  // Turbopack rejects the `.ts` entry in node_modules), and extensionAlias maps its `.js` specifiers
  // back to the `.ts` sources (else `./wire.js` etc. don't resolve).
  transpilePackages: ["@remote-claw/clawsec", "@remote-claw/cli"],
  // @temporalio/client wraps a gRPC/protobuf core that webpack mangles (the "Critical dependency"
  // warning) — bundling it breaks the connection (getSystemInfo fails with undefined status). Keep it
  // external so the Node server loads it from node_modules at runtime. Only loaded when the temporal
  // backend is actually selected (the dynamic import in lib/broker/index.ts).
  serverExternalPackages: ["@temporalio/client"],
  experimental: {
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
};

// withWorkflow wires the Workflow DevKit compiler into the Next build so "use workflow" /
// "use step" functions become durable runs on Vercel Workflows.
export default withWorkflow(nextConfig);
