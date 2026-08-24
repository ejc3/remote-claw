import { tursoScopeFromEnv } from "../../../../lib/broker/turso-cloud-locator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "cdn-cache-control": "no-store",
  "vercel-cdn-cache-control": "no-store",
} as const;

function unavailable(): Response {
  return Response.json(
    { error: "deployment attestation unavailable" },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

const STORAGE_COORDINATE_MAX_BYTES = 256;
const STORAGE_COORDINATE_PATTERN = /^[A-Za-z0-9._-]+$/;

function storageCoordinate(value: string | undefined): string | null {
  const coordinate = value?.trim();
  if (
    !coordinate ||
    !STORAGE_COORDINATE_PATTERN.test(coordinate) ||
    Buffer.byteLength(coordinate, "utf8") > STORAGE_COORDINATE_MAX_BYTES
  ) {
    return null;
  }
  return coordinate;
}

function hasCredential(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Credential-free runtime binding for the deployed smoke. These are deployment/runtime variables,
 * available when Vercel system variables are exposed for the project. Never substitute a branch, URL,
 * build timestamp, or caller-provided value: only an exact Preview or Production environment + full
 * commit SHA with that environment's canonical durable storage profile is an attestation.
 * Organization/group/scope are nonsecret inspection
 * coordinates; credentials are checked only for nonblank completeness and never returned.
 */
export async function GET(): Promise<Response> {
  const rawSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  const sha = rawSha.toLowerCase();
  const environment = process.env.VERCEL_ENV;
  const organization = storageCoordinate(process.env.TURSO_ORG);
  const group = storageCoordinate(process.env.TURSO_GROUP);
  const expectedScope = environment === "production" ? "prod" : `pr-${sha.slice(0, 7)}`;
  if (
    process.env.VERCEL !== "1" ||
    (environment !== "preview" && environment !== "production") ||
    !/^[0-9a-fA-F]{40}$/.test(rawSha) ||
    process.env.BROKER_BACKEND !== "sqlite" ||
    organization === null ||
    group === null ||
    !hasCredential(process.env.TURSO_API_TOKEN) ||
    !hasCredential(process.env.TURSO_GROUP_AUTH_TOKEN) ||
    process.env.RC_TURSO_DB_SCOPE?.trim() ||
    tursoScopeFromEnv() !== expectedScope
  ) {
    return unavailable();
  }

  return Response.json(
    {
      environment,
      sha,
      storage: {
        backend: "sqlite",
        locator: "turso",
        organization,
        group,
        scope: expectedScope,
      },
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
