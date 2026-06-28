import baseConfig from "./app-e2e.config";

// Same REAL spine as app-e2e.config.ts (real Chromium → real Next prod server on BROKER_BACKEND=local →
// real persistent HostRcRelay via seedHost). Only the testMatch differs so the attachment-gap repro spec
// is picked up (the base config pins testMatch to transcript.spec.ts and Playwright has no --testMatch CLI
// flag to override it). Run: `pnpm exec playwright test -c app-e2e.attachment-gap.config.ts --reporter=line`.
export default { ...baseConfig, testMatch: "attachment-gap.spec.ts" };
