import { defineConfig } from "vitest/config";

// The deployment-targeted e2e: it talks to a REAL broker on a Vercel deployment over HTTP (set
// WEB_E2E_URL), so it needs NO in-process Workflow runtime — no `@workflow/vitest` plugin here. The
// test skips itself when WEB_E2E_URL is unset, so this config is a no-op locally and a real check in
// the web-preview CI job (which sets WEB_E2E_URL to the Vercel preview URL).
export default defineConfig({
  resolve: {
    extensionAlias: { ".js": [".ts", ".js"] }, // workspace `.js` specifiers → `.ts` on disk
  },
  test: {
    include: ["test/preview/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
