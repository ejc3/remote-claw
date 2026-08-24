export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "cdn-cache-control": "no-store",
  "vercel-cdn-cache-control": "no-store",
} as const;

const CANARY_PATTERN = /^RC_RELEASE_PROOF_LOG_(?:BEGIN|END)_[0-9a-f]{32}$/;
const MAX_BODY_BYTES = 128;

function unavailable(): Response {
  return Response.json(
    { error: "release proof log canary unavailable" },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

function invalid(): Response {
  return Response.json(
    { error: "invalid release proof log canary" },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

/**
 * Preview-only, nonsecret release-proof marker. The final inspection requires both markers in the
 * immutable deployment's historical runtime-log window. Only the tightly bounded public marker is
 * written: headers, request metadata, bodies, credentials, and arbitrary caller text are never logged.
 */
export async function POST(request: Request): Promise<Response> {
  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "preview") {
    return unavailable();
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return invalid();
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    return invalid();
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return invalid();
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return invalid();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("canary" in body) ||
    typeof body.canary !== "string" ||
    !CANARY_PATTERN.test(body.canary)
  ) {
    return invalid();
  }

  // This is intentionally the only runtime output from this route.
  console.info(body.canary);
  return Response.json({ accepted: true }, { status: 200, headers: NO_STORE_HEADERS });
}
