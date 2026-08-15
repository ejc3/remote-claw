import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A1_BROKER_MAX_READ_ENCODED_BYTES,
  type A1EncryptedFrameV2,
  base64urlEncode,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  encodeA1BrokerReadPageV1,
  encodeA1EncryptedFrameV2,
  toHex,
} from "@remote-claw/clawsec";
import { A1BrokerClient } from "@remote-claw/cli/broker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as capabilities } from "../../app/api/a1/capabilities/route";
import { POST as relay } from "../../app/api/a1/relay/route";
import { POST as openRoute } from "../../app/api/a1/route/open/route";
import { POST as subscribe } from "../../app/api/a1/subscribe/route";
import {
  A1_BROKER_CAPABILITIES,
  A1_BROKER_CAPABILITIES_DIGEST,
  A1_CAPABILITIES_DIGEST_HEADER,
  A1_ROUTE_KIND_HEADER,
  A1_ROUTE_STORE_INSTANCE_HEADER,
  A1_ROUTE_TOKEN_HEADER,
} from "../../lib/broker/a1-contract";
import { evictA1SqliteBackend } from "../../lib/broker/a1-sqlite";
import { bearer, uniqueIdentity } from "../helpers";

const dirs: string[] = [];
const originalSqliteDir = process.env.RC_SQLITE_DIR;
const storageEnvNames = [
  "VERCEL",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "TURSO_GROUP_AUTH_TOKEN",
] as const;
const originalStorageEnv = new Map(storageEnvNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "rc-a1-http-"));
  dirs.push(dir);
  process.env.RC_SQLITE_DIR = dir;
  for (const name of storageEnvNames) delete process.env[name];
  evictA1SqliteBackend();
});

afterEach(() => {
  evictA1SqliteBackend();
  if (originalSqliteDir === undefined) delete process.env.RC_SQLITE_DIR;
  else process.env.RC_SQLITE_DIR = originalSqliteDir;
  for (const name of storageEnvNames) {
    const value = originalStorageEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function id(prefix: "rcs_" | "rcl_" | "rda_", start: number): string {
  return `${prefix}${base64urlEncode(bytes(16, start))}`;
}

async function fixture() {
  const identity = await uniqueIdentity();
  const collaborationServerId = id("rcs_", 0x10);
  const logicalChatId = id("rcl_", 0x30);
  const route = {
    routeKind: "chat" as const,
    identityId: identity.identityId,
    collaborationServerId,
    logicalChatId,
  };
  const routeToken = await deriveA1ChatToken(
    identity.identityId,
    collaborationServerId,
    logicalChatId,
  );
  const common = {
    v: 1,
    identity_id: toHex(identity.identityId),
    collaboration_server_id: collaborationServerId,
    route_kind: "chat",
    logical_chat_id: logicalChatId,
    route_token: routeToken,
    expected_route_store_instance_id: null,
  } as const;
  return {
    identity,
    route,
    routeToken,
    brokerRouteId: await deriveA1BrokerRouteId(route),
    common,
  };
}

function requestHeaders(authorization: string, json = true): Record<string, string> {
  return {
    authorization,
    "x-broker-backend": "sqlite",
    [A1_CAPABILITIES_DIGEST_HEADER]: A1_BROKER_CAPABILITIES_DIGEST,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function a1Frame(f: Awaited<ReturnType<typeof fixture>>, change = 0): A1EncryptedFrameV2 {
  return {
    v: 2,
    identityId: f.identity.identityId,
    collaborationServerId: f.route.collaborationServerId,
    logicalChatId: f.route.logicalChatId,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "source.msg-1",
    deliveryAttemptId: id("rda_", 0x50),
    clientMsgId: "client:proposal-1",
    keyEpoch: 0,
    salt: bytes(32, 0x70 + change),
    nonce: bytes(12, 0x90 + change),
    ct: bytes(16, 0xb0 + change),
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
    hostSignature: null,
  };
}

async function open(input?: Awaited<ReturnType<typeof fixture>>) {
  const f = input ?? (await fixture());
  const response = await openRoute(
    new Request("http://broker.test/api/a1/route/open", {
      method: "POST",
      headers: requestHeaders(bearer(f.identity.authToken)),
      body: JSON.stringify(f.common),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { f, response, body, storeId: String(body.route_store_instance_id) };
}

describe("selected-A1 HTTP routes", () => {
  it("round-trips through the shared dormant CLI A1 client without a translation fork", async () => {
    const f = await fixture();
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      switch (new URL(request.url).pathname) {
        case "/api/a1/capabilities":
          return capabilities(request);
        case "/api/a1/route/open":
          return openRoute(request);
        case "/api/a1/relay":
          return relay(request);
        case "/api/a1/subscribe":
          return subscribe(request);
        default:
          return new Response(null, { status: 404 });
      }
    };
    const client = new A1BrokerClient({
      baseUrl: "http://broker.test",
      provider: { authBearer: () => f.identity.authToken.slice() },
      fetchFn,
    });
    const negotiated = await client.negotiate();
    const handle = await negotiated.openRoute(f.route);
    const canonical = encodeA1EncryptedFrameV2(a1Frame(f));
    const published = await handle.publish(canonical);
    const page = await handle.read({
      position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      maxFrames: 1,
    });

    expect(published).toMatchObject({
      outcome: "inserted",
      cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
    });
    expect(page).toMatchObject({
      observedNextFrameIndex: 1,
      atLiveTail: true,
      nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 1 },
    });
    expect(page.frames).toHaveLength(1);
    expect(page.frames[0]?.canonicalFrame).toBe(canonical);
  });

  it("accepts a near-limit snake-case page even when the clawsec camel-case encoding is larger", async () => {
    const f = await fixture();
    let transmittedReadBody = "";
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      switch (new URL(request.url).pathname) {
        case "/api/a1/capabilities":
          return capabilities(request);
        case "/api/a1/route/open":
          return openRoute(request);
        case "/api/a1/relay":
          return relay(request);
        case "/api/a1/subscribe": {
          const response = await subscribe(request);
          transmittedReadBody = await response.clone().text();
          return response;
        }
        default:
          return new Response(null, { status: 404 });
      }
    };
    const client = new A1BrokerClient({
      baseUrl: "http://broker.test",
      provider: { authBearer: () => f.identity.authToken.slice() },
      fetchFn,
    });
    const handle = await (await client.negotiate()).openRoute(f.route);

    const first: A1EncryptedFrameV2 = {
      ...a1Frame(f),
      ct: new Uint8Array(2_999_000).fill(0xa1),
    };
    const firstCanonical = encodeA1EncryptedFrameV2(first);

    const secondFrame = (ciphertextBytes: number): A1EncryptedFrameV2 => ({
      ...a1Frame(f, 1),
      deliveryAttemptId: id("rda_", 0x51),
      ct: new Uint8Array(ciphertextBytes).fill(0xb2),
    });
    const predictedHttpBytes = (secondCanonical: string): number =>
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          broker_route_id: handle.descriptor.brokerRouteId,
          route_store_instance_id: handle.descriptor.routeStoreInstanceId,
          generation: {
            channel_generation: 0,
            state: "open",
            frame_count: null,
            next_generation: null,
            manifest_digest: null,
          },
          frames: [
            {
              cursor: { version: 1, channel_generation: 0, frame_index: 0 },
              delivery_attempt_id: first.deliveryAttemptId,
              part: first.part,
              transport_frame_digest: "x".repeat(43),
              frame: firstCanonical,
            },
            {
              cursor: { version: 1, channel_generation: 0, frame_index: 1 },
              delivery_attempt_id: id("rda_", 0x51),
              part: 0,
              transport_frame_digest: "x".repeat(43),
              frame: secondCanonical,
            },
          ],
          next_position: { version: 1, channel_generation: 0, next_frame_index: 2 },
          observed_next_frame_index: 2,
          at_live_tail: true,
        }),
      ).byteLength;

    // Canonical base64url grows by roughly four bytes for each three ciphertext bytes. Tune the
    // second valid frame to the largest spelling the exact snake-case HTTP envelope can carry.
    let secondCiphertextBytes = 2_999_000;
    let secondCanonical = encodeA1EncryptedFrameV2(secondFrame(secondCiphertextBytes));
    secondCiphertextBytes += Math.floor(
      ((A1_BROKER_MAX_READ_ENCODED_BYTES - predictedHttpBytes(secondCanonical)) * 3) / 4,
    );
    secondCanonical = encodeA1EncryptedFrameV2(secondFrame(secondCiphertextBytes));
    while (predictedHttpBytes(secondCanonical) > A1_BROKER_MAX_READ_ENCODED_BYTES) {
      secondCiphertextBytes--;
      secondCanonical = encodeA1EncryptedFrameV2(secondFrame(secondCiphertextBytes));
    }
    for (;;) {
      const candidate = encodeA1EncryptedFrameV2(secondFrame(secondCiphertextBytes + 1));
      if (predictedHttpBytes(candidate) > A1_BROKER_MAX_READ_ENCODED_BYTES) break;
      secondCiphertextBytes++;
      secondCanonical = candidate;
    }

    expect(secondCiphertextBytes).toBeLessThan(3_300_000);
    expect(predictedHttpBytes(secondCanonical)).toBeLessThanOrEqual(
      A1_BROKER_MAX_READ_ENCODED_BYTES,
    );
    await handle.publish(firstCanonical);
    await handle.publish(secondCanonical);
    const page = await handle.read({
      position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      maxFrames: 2,
    });

    const transmittedBytes = new TextEncoder().encode(transmittedReadBody).byteLength;
    expect(page.frames).toHaveLength(2);
    expect(transmittedBytes).toBe(predictedHttpBytes(secondCanonical));
    expect(transmittedBytes).toBeGreaterThan(A1_BROKER_MAX_READ_ENCODED_BYTES - 4);
    expect(transmittedBytes).toBeLessThanOrEqual(A1_BROKER_MAX_READ_ENCODED_BYTES);
    expect(
      new TextEncoder().encode(await encodeA1BrokerReadPageV1(page)).byteLength,
    ).toBeGreaterThan(A1_BROKER_MAX_READ_ENCODED_BYTES);
  }, 120_000);

  it("advertises only the exact vector behind bearer + literal sqlite selection", async () => {
    const f = await fixture();
    const auth = bearer(f.identity.authToken);
    const missingAuth = await capabilities(
      new Request("http://broker.test/api/a1/capabilities", {
        headers: { "x-broker-backend": "sqlite" },
      }),
    );
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({ v: 1, error: "unauthorized" });

    const noncanonicalAuthorizations = [
      new Headers({
        authorization: auth.toUpperCase().replace("BEARER ", "Bearer "),
        "x-broker-backend": "sqlite",
      }),
      new Headers({
        authorization: auth.replace("Bearer ", "Bearer  "),
        "x-broker-backend": "sqlite",
      }),
      new Headers([
        ["authorization", auth],
        ["authorization", auth],
        ["x-broker-backend", "sqlite"],
      ]),
    ];
    for (const headers of noncanonicalAuthorizations) {
      const noncanonicalAuth = await capabilities(
        new Request("http://broker.test/api/a1/capabilities", { headers }),
      );
      expect(noncanonicalAuth.status).toBe(401);
      expect(await noncanonicalAuth.json()).toEqual({ v: 1, error: "unauthorized" });
    }

    const queryFallback = await capabilities(
      new Request("http://broker.test/api/a1/capabilities?backend=sqlite", {
        headers: { authorization: auth },
      }),
    );
    expect(queryFallback.status).toBe(400);
    expect(await queryFallback.json()).toEqual({ v: 1, error: "backend_selector_required" });

    const unsupported = await capabilities(
      new Request("http://broker.test/api/a1/capabilities", {
        headers: { authorization: auth, "x-broker-backend": "local" },
      }),
    );
    expect(unsupported.status).toBe(501);
    expect(await unsupported.json()).toEqual({ v: 1, error: "a1_backend_unsupported" });

    const response = await capabilities(
      new Request("http://broker.test/api/a1/capabilities", {
        headers: { authorization: auth, "x-broker-backend": "sqlite" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(A1_BROKER_CAPABILITIES);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(A1_CAPABILITIES_DIGEST_HEADER)).toBe(A1_BROKER_CAPABILITIES_DIGEST);
  });

  it("fails capability negotiation closed for absent or partial Turso fleet config on Vercel", async () => {
    const f = await fixture();
    const auth = bearer(f.identity.authToken);
    const request = () =>
      capabilities(
        new Request("http://broker.test/api/a1/capabilities", {
          headers: { authorization: auth, "x-broker-backend": "sqlite" },
        }),
      );

    process.env.VERCEL = "1";
    let response = await request();
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ v: 1, error: "a1_backend_unsupported" });

    process.env.TURSO_API_TOKEN = "api";
    response = await request();
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ v: 1, error: "a1_backend_unsupported" });

    delete process.env.VERCEL;
    response = await request();
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ v: 1, error: "a1_backend_unsupported" });
  });

  it("opens/replays an exact route with full genesis and sampled current tip", async () => {
    const first = await open();
    expect(first.response.status).toBe(200);
    expect(first.body).toEqual({
      v: 1,
      disposition: "created",
      broker_route_id: first.f.brokerRouteId,
      route_store_instance_id: first.storeId,
      broker_backend_capabilities_digest: A1_BROKER_CAPABILITIES_DIGEST,
      genesis: {
        channel_generation: 0,
        state: "open",
        frame_count: null,
        next_generation: null,
        manifest_digest: null,
      },
      current_generation: {
        channel_generation: 0,
        state: "open",
        frame_count: null,
        next_generation: null,
        manifest_digest: null,
      },
      observed_next_frame_index: 0,
    });
    const replayBody = {
      ...first.f.common,
      expected_route_store_instance_id: first.storeId,
    };
    const replay = await openRoute(
      new Request("http://broker.test/api/a1/route/open", {
        method: "POST",
        headers: requestHeaders(bearer(first.f.identity.authToken)),
        body: JSON.stringify(replayBody),
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      disposition: "existing",
      route_store_instance_id: first.storeId,
      observed_next_frame_index: 0,
    });

    const wrongStore = await openRoute(
      new Request("http://broker.test/api/a1/route/open", {
        method: "POST",
        headers: requestHeaders(bearer(first.f.identity.authToken)),
        body: JSON.stringify({
          ...first.f.common,
          expected_route_store_instance_id: `rbsi_${base64urlEncode(bytes(16, 0xee))}`,
        }),
      }),
    );
    expect(wrongStore.status).toBe(409);
    expect(await wrongStore.json()).toEqual({ v: 1, error: "route_store_mismatch" });
  });

  it("publishes canonical bytes, retries the original cursor, collides, and reads a sampled page", async () => {
    const first = await open();
    const frame = a1Frame(first.f);
    const canonical = encodeA1EncryptedFrameV2(frame);
    const relayHeaders = {
      ...requestHeaders(bearer(first.f.identity.authToken)),
      [A1_ROUTE_KIND_HEADER]: "chat",
      [A1_ROUTE_TOKEN_HEADER]: first.f.routeToken,
      [A1_ROUTE_STORE_INSTANCE_HEADER]: first.storeId,
    };
    const publish = () =>
      relay(
        new Request("http://broker.test/api/a1/relay", {
          method: "POST",
          headers: relayHeaders,
          body: ` \n ${canonical} \n`,
        }),
      );
    const inserted = await publish();
    expect(inserted.status).toBe(200);
    const insertedBody = await inserted.json();
    expect(insertedBody).toMatchObject({
      v: 1,
      disposition: "inserted",
      broker_route_id: first.f.brokerRouteId,
      route_store_instance_id: first.storeId,
      cursor: { version: 1, channel_generation: 0, frame_index: 0 },
    });
    const retry = await publish();
    expect(await retry.json()).toEqual({ ...insertedBody, disposition: "exact_retry" });

    const collision = await relay(
      new Request("http://broker.test/api/a1/relay", {
        method: "POST",
        headers: relayHeaders,
        body: encodeA1EncryptedFrameV2(a1Frame(first.f, 1)),
      }),
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({
      v: 1,
      error: "transport_collision",
      broker_route_id: first.f.brokerRouteId,
      route_store_instance_id: first.storeId,
      delivery_attempt_id: frame.deliveryAttemptId,
      part: 0,
      original_cursor: { version: 1, channel_generation: 0, frame_index: 0 },
    });

    const page = await subscribe(
      new Request("http://broker.test/api/a1/subscribe", {
        method: "POST",
        headers: requestHeaders(bearer(first.f.identity.authToken)),
        body: JSON.stringify({
          ...first.f.common,
          expected_route_store_instance_id: first.storeId,
          position: { version: 1, channel_generation: 0, next_frame_index: 0 },
          max_frames: 64,
        }),
      }),
    );
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      v: 1,
      generation: {
        channel_generation: 0,
        state: "open",
        frame_count: null,
        next_generation: null,
        manifest_digest: null,
      },
      frames: [
        {
          cursor: { version: 1, channel_generation: 0, frame_index: 0 },
          delivery_attempt_id: frame.deliveryAttemptId,
          part: 0,
          frame: canonical,
        },
      ],
      next_position: { version: 1, channel_generation: 0, next_frame_index: 1 },
      observed_next_frame_index: 1,
      at_live_tail: true,
    });
  });

  it("rejects duplicate JSON members, transplant headers, stale capabilities, and unsupported media", async () => {
    const f = await fixture();
    const auth = bearer(f.identity.authToken);
    const body = JSON.stringify(f.common);
    const duplicate = body.replace('{"v":1,', '{"v":1,"v":1,');
    const duplicateResponse = await openRoute(
      new Request("http://broker.test/api/a1/route/open", {
        method: "POST",
        headers: requestHeaders(auth),
        body: duplicate,
      }),
    );
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toEqual({ v: 1, error: "invalid_request" });

    for (const invalidUtf8 of [
      new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      new Uint8Array([0xff]),
      new TextEncoder().encode(`\u00a0${body}`),
    ]) {
      const response = await openRoute(
        new Request("http://broker.test/api/a1/route/open", {
          method: "POST",
          headers: requestHeaders(auth),
          body: invalidUtf8,
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ v: 1, error: "invalid_request" });
    }

    const staleCapabilities = await openRoute(
      new Request("http://broker.test/api/a1/route/open", {
        method: "POST",
        headers: {
          ...requestHeaders(auth),
          [A1_CAPABILITIES_DIGEST_HEADER]: base64urlEncode(bytes(32, 0x77)),
        },
        body,
      }),
    );
    expect(staleCapabilities.status).toBe(409);
    expect(await staleCapabilities.json()).toEqual({
      v: 1,
      error: "broker_capabilities_mismatch",
    });

    const media = await openRoute(
      new Request("http://broker.test/api/a1/route/open", {
        method: "POST",
        headers: requestHeaders(auth, false),
        body,
      }),
    );
    expect(media.status).toBe(415);
    expect(await media.json()).toEqual({ v: 1, error: "unsupported_media_type" });

    const first = await open(f);
    const frame = encodeA1EncryptedFrameV2(a1Frame(f));
    const transplant = await relay(
      new Request("http://broker.test/api/a1/relay", {
        method: "POST",
        headers: {
          ...requestHeaders(auth),
          [A1_ROUTE_KIND_HEADER]: "chat",
          [A1_ROUTE_TOKEN_HEADER]: `${f.routeToken}x`,
          [A1_ROUTE_STORE_INSTANCE_HEADER]: first.storeId,
        },
        body: frame,
      }),
    );
    expect(transplant.status).toBe(403);
    expect(await transplant.json()).toEqual({ v: 1, error: "route_auth_mismatch" });

    const duplicateFrame = frame.replace('{"v":2,', '{"v":2,"v":2,');
    const badFrame = await relay(
      new Request("http://broker.test/api/a1/relay", {
        method: "POST",
        headers: {
          ...requestHeaders(auth),
          [A1_ROUTE_KIND_HEADER]: "chat",
          [A1_ROUTE_TOKEN_HEADER]: f.routeToken,
          [A1_ROUTE_STORE_INSTANCE_HEADER]: first.storeId,
        },
        body: duplicateFrame,
      }),
    );
    expect(badFrame.status).toBe(400);
    expect(await badFrame.json()).toEqual({ v: 1, error: "invalid_request" });
  });

  it("enforces advertised body bounds before parsing or store access", async () => {
    const f = await fixture();
    const headers = requestHeaders(bearer(f.identity.authToken));
    const control = await openRoute(
      new Request("http://broker.test/api/a1/route/open", {
        method: "POST",
        headers: { ...headers, "content-length": "8193" },
        body: "{}",
      }),
    );
    expect(control.status).toBe(413);
    expect(await control.json()).toEqual({ v: 1, error: "frame_too_large" });

    const raw = await relay(
      new Request("http://broker.test/api/a1/relay", {
        method: "POST",
        headers: { ...headers, "content-length": "4450001" },
        body: "{}",
      }),
    );
    expect(raw.status).toBe(413);
    expect(await raw.json()).toEqual({ v: 1, error: "frame_too_large" });

    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_300_000));
        controller.enqueue(new Uint8Array(2_300_000));
        controller.close();
      },
    });
    const chunked = await relay(
      new Request("http://broker.test/api/a1/relay", {
        method: "POST",
        headers,
        body: chunkedBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(chunked.status).toBe(413);
    expect(await chunked.json()).toEqual({ v: 1, error: "frame_too_large" });
  });
});
