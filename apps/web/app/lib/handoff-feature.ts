/**
 * QR/OTK handoff is an opt-in deployment feature because its unauthenticated endpoint requires an
 * externally enforced per-IP WAF rate limit. This public flag is configuration, not a secret; the
 * deployment may set it to exactly `1` only after that edge control has been verified.
 *
 * Keep the direct `process.env.NEXT_PUBLIC_…` access: Next replaces it in the browser bundle at build
 * time, while route handlers read the same deployment setting.
 */
export function handoffEnabled(
  configured: string | undefined = process.env.NEXT_PUBLIC_RC_HANDOFF_ENABLED,
): boolean {
  return configured === "1";
}
