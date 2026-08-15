import {
  A1_BROKER_MAX_RAW_FRAME_BYTES,
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  base64urlEncode,
  brokerBackendCapabilitiesDigest,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  encodeA1EncryptedFrameV2,
  parseA1BrokerCanonicalFrameV1,
  SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
  sha256,
  toHex,
} from "@remote-claw/clawsec";
import { describe, expect, it, vi } from "vitest";
import {
  A1BrokerClient,
  A1BrokerHttpError,
  A1BrokerOutcomeUnknownError,
  A1BrokerProtocolError,
  A1BrokerTransportCollisionError,
  internalA1BrokerEvidenceReader,
} from "./a1-client.js";

function bytes(length: number, start = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

const AUTH_TOKEN = bytes(32, 1);
const SERVER_ID = `rcs_${base64urlEncode(bytes(16, 0x20))}`;
const CHAT_ID = `rcl_${base64urlEncode(bytes(16, 0x30))}`;
const ATTEMPT_ID = `rda_${base64urlEncode(bytes(16, 0x40))}`;
const STORE_ID = `rbsi_${base64urlEncode(bytes(16, 0x50))}`;
const OTHER_STORE_ID = `rbsi_${base64urlEncode(bytes(16, 0x51))}`;
const OTHER_SERVER_ID = `rcs_${base64urlEncode(bytes(16, 0x21))}`;
const OTHER_ATTEMPT_ID = `rda_${base64urlEncode(bytes(16, 0x41))}`;
const CAPABILITY_HEADER = "x-remote-claw-a1-capabilities-digest";

function response(body: unknown, capabilityDigest: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      [CAPABILITY_HEADER]: capabilityDigest,
    },
  });
}

function frame(
  identityId: Uint8Array,
  overrides: Partial<A1EncryptedFrameV2> = {},
): A1EncryptedFrameV2 {
  return {
    v: 2,
    identityId,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "message.one",
    deliveryAttemptId: ATTEMPT_ID,
    clientMsgId: "client.one",
    keyEpoch: 0,
    salt: bytes(32, 0x60),
    nonce: bytes(12, 0x80),
    ct: bytes(16, 0x90),
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
    hostSignature: null,
    ...overrides,
  };
}

interface FakeBrokerOptions {
  readonly collide?: boolean;
  readonly wrongStore?: boolean;
  readonly response?: (
    endpoint: "capabilities" | "open" | "publish" | "read",
    response: Response,
  ) => Promise<Response> | Response;
}

async function rewrittenJson(
  source: Response,
  rewrite: (body: Record<string, unknown>) => unknown,
): Promise<Response> {
  const body = (await source.json()) as Record<string, unknown>;
  return new Response(JSON.stringify(rewrite(body)), {
    status: source.status,
    headers: new Headers(source.headers),
  });
}

function withHeaders(source: Response, rewrite: (headers: Headers) => void): Response {
  const headers = new Headers(source.headers);
  rewrite(headers);
  return new Response(source.body, { status: source.status, headers });
}

async function fakeBroker(options: FakeBrokerOptions = {}): Promise<{
  readonly fetchFn: typeof fetch;
  readonly route: A1BrokerRoute;
  readonly canonicalFrame: string;
  readonly calls: ReturnType<typeof vi.fn>;
}> {
  const identityId = (await sha256(AUTH_TOKEN)).slice(0, 16);
  const route: A1BrokerRoute = {
    routeKind: "chat",
    identityId,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
  };
  const brokerRouteId = await deriveA1BrokerRouteId(route);
  const routeToken = await deriveA1ChatToken(identityId, SERVER_ID, CHAT_ID);
  const capabilityDigest = await brokerBackendCapabilitiesDigest(
    SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
  );
  const inspected = await parseA1BrokerCanonicalFrameV1(
    encodeA1EncryptedFrameV2(frame(identityId)),
  );
  const originalDigest = base64urlEncode(new Uint8Array(32).fill(7));
  const calls = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${toHex(AUTH_TOKEN)}`);
    expect(headers.get("x-broker-backend")).toBe("sqlite");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    if (url.endsWith("/api/a1/capabilities")) {
      expect(headers.get(CAPABILITY_HEADER)).toBeNull();
      const result = response(SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1, capabilityDigest);
      return (await options.response?.("capabilities", result)) ?? result;
    }
    expect(headers.get(CAPABILITY_HEADER)).toBe(capabilityDigest);
    if (url.endsWith("/api/a1/route/open")) {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toEqual({
        v: 1,
        identity_id: toHex(identityId),
        collaboration_server_id: SERVER_ID,
        route_kind: "chat",
        logical_chat_id: CHAT_ID,
        route_token: routeToken,
        expected_route_store_instance_id: options.wrongStore ? STORE_ID : null,
      });
      const result = response(
        {
          v: 1,
          disposition: "created",
          broker_route_id: brokerRouteId,
          route_store_instance_id: options.wrongStore
            ? `rbsi_${base64urlEncode(bytes(16, 99))}`
            : STORE_ID,
          broker_backend_capabilities_digest: capabilityDigest,
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
        },
        capabilityDigest,
      );
      return (await options.response?.("open", result)) ?? result;
    }
    if (url.endsWith("/api/a1/relay")) {
      expect(headers.get("x-remote-claw-a1-route-kind")).toBe("chat");
      expect(headers.get("x-remote-claw-a1-route-token")).toBe(routeToken);
      expect(headers.get("x-remote-claw-a1-route-store-instance-id")).toBe(STORE_ID);
      const current = await parseA1BrokerCanonicalFrameV1(String(init?.body));
      if (options.collide) {
        const result = response(
          {
            v: 1,
            error: "transport_collision",
            broker_route_id: brokerRouteId,
            route_store_instance_id: STORE_ID,
            delivery_attempt_id: current.frame.deliveryAttemptId,
            part: current.frame.part,
            original_cursor: { version: 1, channel_generation: 0, frame_index: 0 },
            original_transport_frame_digest: originalDigest,
            first_conflicting_transport_frame_digest: current.transportFrameDigest,
            conflicting_transport_frame_digest: current.transportFrameDigest,
          },
          capabilityDigest,
          409,
        );
        return (await options.response?.("publish", result)) ?? result;
      }
      const result = response(
        {
          v: 1,
          disposition: "inserted",
          broker_route_id: brokerRouteId,
          route_store_instance_id: STORE_ID,
          cursor: { version: 1, channel_generation: 0, frame_index: 0 },
          transport_frame_digest: current.transportFrameDigest,
        },
        capabilityDigest,
      );
      return (await options.response?.("publish", result)) ?? result;
    }
    if (url.endsWith("/api/a1/subscribe")) {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request.position).toEqual({ version: 1, channel_generation: 0, next_frame_index: 0 });
      const result = response(
        {
          v: 1,
          broker_route_id: brokerRouteId,
          route_store_instance_id: STORE_ID,
          generation: {
            channel_generation: 0,
            state: "open",
            frame_count: null,
            next_generation: null,
            manifest_digest: null,
          },
          observed_next_frame_index: 1,
          frames: [
            {
              cursor: { version: 1, channel_generation: 0, frame_index: 0 },
              delivery_attempt_id: ATTEMPT_ID,
              part: 0,
              transport_frame_digest: inspected.transportFrameDigest,
              frame: inspected.canonicalFrame,
            },
          ],
          next_position: { version: 1, channel_generation: 0, next_frame_index: 1 },
          at_live_tail: true,
        },
        capabilityDigest,
      );
      return (await options.response?.("read", result)) ?? result;
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  return {
    fetchFn: calls as unknown as typeof fetch,
    route,
    canonicalFrame: inspected.canonicalFrame,
    calls,
  };
}

function client(fetchFn: typeof fetch): A1BrokerClient {
  return new A1BrokerClient({
    baseUrl: "https://broker.example/",
    provider: { authBearer: () => AUTH_TOKEN.slice() },
    fetchFn,
  });
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("A1BrokerClient", () => {
  it("negotiates before opening, then binds publish and bounded reads to one route/store", async () => {
    const fake = await fakeBroker();
    const negotiated = await client(fake.fetchFn).negotiate();
    const route = await negotiated.openRoute(fake.route);
    const published = await route.publish(fake.canonicalFrame);
    const page = await route.read({
      position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      maxFrames: 1,
    });

    expect(published.outcome).toBe("inserted");
    expect(published.cursor).toEqual({ version: 1, channelGeneration: 0, frameIndex: 0 });
    expect(page.frames).toHaveLength(1);
    expect(page.atLiveTail).toBe(true);
    expect(fake.calls).toHaveBeenCalledTimes(4);
  });

  it("snapshots a custom provider bearer without mutating provider-owned storage", async () => {
    const retainedBearer = AUTH_TOKEN.slice();
    const before = retainedBearer.slice();
    const fake = await fakeBroker();
    const negotiated = await new A1BrokerClient({
      baseUrl: "https://broker.example",
      provider: { authBearer: () => retainedBearer },
      fetchFn: fake.fetchFn,
    }).negotiate();
    const route = await negotiated.openRoute(fake.route);
    await route.publish(fake.canonicalFrame);
    expect(retainedBearer).toEqual(before);
  });

  it("surfaces a durable changed-retry collision without retrying it", async () => {
    const fake = await fakeBroker({ collide: true });
    const route = await (await client(fake.fetchFn).negotiate()).openRoute(fake.route);
    await expect(route.publish(fake.canonicalFrame)).rejects.toBeInstanceOf(
      A1BrokerTransportCollisionError,
    );
    expect(fake.calls).toHaveBeenCalledTimes(3);
  });

  it("rejects a changed expected store and noncanonical publish before accepting a receipt", async () => {
    const fake = await fakeBroker({ wrongStore: true });
    const negotiated = await client(fake.fetchFn).negotiate();
    await expect(
      negotiated.openRoute(fake.route, { expectedRouteStoreInstanceId: STORE_ID }),
    ).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);

    const good = await fakeBroker();
    const route = await (await client(good.fetchFn).negotiate()).openRoute(good.route);
    await expect(route.publish(` ${good.canonicalFrame}`)).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );
    expect(good.calls).toHaveBeenCalledTimes(2);
  });

  it("treats fetch failure as an unknown outcome and never falls back to a default backend", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-broker-backend")).toBe("sqlite");
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch;
    await expect(client(fetchFn).negotiate()).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous broker origins before any request", () => {
    expect(
      () =>
        new A1BrokerClient({
          baseUrl: "https://user@example.test/path",
          provider: { authBearer: () => AUTH_TOKEN.slice() },
          fetchFn: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/brokerOrigin/);
  });

  it("requires the selected capability header, JSON media type, and no-store on negotiation", async () => {
    const corruptions: ReadonlyArray<(headers: Headers) => void> = [
      (headers) => headers.delete(CAPABILITY_HEADER),
      (headers) => headers.set(CAPABILITY_HEADER, base64urlEncode(bytes(32, 0xa0))),
      (headers) => headers.delete("cache-control"),
      (headers) => headers.set("content-type", "text/html"),
    ];
    for (const corrupt of corruptions) {
      const fake = await fakeBroker({
        response: (endpoint, source) =>
          endpoint === "capabilities" ? withHeaders(source, corrupt) : source,
      });
      await expect(client(fake.fetchFn).negotiate()).rejects.toBeInstanceOf(A1BrokerProtocolError);
      expect(fake.calls).toHaveBeenCalledTimes(1);
    }
  });

  it("requires the negotiated response headers before trusting success or error bodies", async () => {
    const capabilityDigest = await brokerBackendCapabilitiesDigest(
      SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const missingHeader = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "open"
          ? withHeaders(
              response({ v: 1, error: "route_store_mismatch" }, capabilityDigest, 409),
              (headers) => headers.delete(CAPABILITY_HEADER),
            )
          : source,
    });
    const negotiated = await client(missingHeader.fetchFn).negotiate();
    await expect(negotiated.openRoute(missingHeader.route)).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );

    const exactError = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "open"
          ? response({ v: 1, error: "route_store_mismatch" }, capabilityDigest, 409)
          : source,
    });
    const exactNegotiated = await client(exactError.fetchFn).negotiate();
    const error = await rejected(exactNegotiated.openRoute(exactError.route));
    expect(error).toBeInstanceOf(A1BrokerHttpError);
    expect(error).toMatchObject({ status: 409, code: "route_store_mismatch" });
  });

  it("classifies committed mutation failures without inviting a changed retry", async () => {
    const capabilityDigest = await brokerBackendCapabilitiesDigest(
      SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
    );
    for (const endpoint of ["open", "publish"] as const) {
      for (const outcome of ["broker_failure", "malformed_success"] as const) {
        const fake = await fakeBroker({
          response: (current, source) => {
            if (current !== endpoint) return source;
            return outcome === "broker_failure"
              ? response({ v: 1, error: "broker_failure" }, capabilityDigest, 500)
              : new Response("{", {
                  status: 200,
                  headers: new Headers(source.headers),
                });
          },
        });
        const negotiated = await client(fake.fetchFn).negotiate();
        const error =
          endpoint === "open"
            ? await rejected(negotiated.openRoute(fake.route))
            : await rejected((await negotiated.openRoute(fake.route)).publish(fake.canonicalFrame));
        expect(error).toBeInstanceOf(A1BrokerOutcomeUnknownError);
        expect(error).not.toHaveProperty("cause");
      }
    }
  });

  it("binds exact success/error statuses while retaining deterministic 501/507 outcomes", async () => {
    const capabilityDigest = await brokerBackendCapabilitiesDigest(
      SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
    );
    for (const [status, code] of [
      [501, "a1_backend_unsupported"],
      [507, "counter_exhausted"],
    ] as const) {
      for (const target of ["open", "publish"] as const) {
        const fake = await fakeBroker({
          response: (endpoint, source) =>
            endpoint === target
              ? response({ v: 1, error: code }, capabilityDigest, status)
              : source,
        });
        const negotiated = await client(fake.fetchFn).negotiate();
        const error =
          target === "open"
            ? await rejected(negotiated.openRoute(fake.route))
            : await rejected((await negotiated.openRoute(fake.route)).publish(fake.canonicalFrame));
        expect(error).toBeInstanceOf(A1BrokerHttpError);
        expect(error).toMatchObject({ status, code });
      }
    }

    for (const [status, code] of [
      [401, "route_not_found"],
      [404, "unauthorized"],
    ] as const) {
      const fake = await fakeBroker({
        response: (endpoint, source) =>
          endpoint === "open" ? response({ v: 1, error: code }, capabilityDigest, status) : source,
      });
      await expect(
        (await client(fake.fetchFn).negotiate()).openRoute(fake.route),
      ).rejects.toBeInstanceOf(A1BrokerProtocolError);
    }

    const noncanonicalSuccess = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "open"
          ? new Response(source.body, { status: 201, headers: new Headers(source.headers) })
          : source,
    });
    await expect(
      (await client(noncanonicalSuccess.fetchFn).negotiate()).openRoute(noncanonicalSuccess.route),
    ).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);

    const misplacedCollision = await fakeBroker({
      collide: true,
      response: (endpoint, source) =>
        endpoint === "publish"
          ? new Response(source.body, { status: 400, headers: new Headers(source.headers) })
          : source,
    });
    const route = await (await client(misplacedCollision.fetchFn).negotiate()).openRoute(
      misplacedCollision.route,
    );
    await expect(route.publish(misplacedCollision.canonicalFrame)).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );
  });

  it("rejects extra capability, route-open, and error fields instead of accepting proxy shapes", async () => {
    const capabilities = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "capabilities"
          ? rewrittenJson(source, (body) => ({ ...body, proxy_added: true }))
          : source,
    });
    await expect(client(capabilities.fetchFn).negotiate()).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );

    const duplicate = await fakeBroker({
      response: (endpoint, source) => {
        if (endpoint !== "capabilities") return source;
        const raw = JSON.stringify(SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1).replace(
          '"schemaVersion":1',
          '"schemaVersion":0,"schemaVersion":1',
        );
        return new Response(raw, { status: source.status, headers: new Headers(source.headers) });
      },
    });
    await expect(client(duplicate.fetchFn).negotiate()).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );

    const open = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "open"
          ? rewrittenJson(source, (body) => ({ ...body, proxy_added: true }))
          : source,
    });
    await expect(
      (await client(open.fetchFn).negotiate()).openRoute(open.route),
    ).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);

    const capabilityDigest = await brokerBackendCapabilitiesDigest(
      SELECTED_A1_BROKER_BACKEND_CAPABILITIES_V1,
    );
    const error = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "open"
          ? response(
              { v: 1, error: "route_store_mismatch", proxy_added: true },
              capabilityDigest,
              409,
            )
          : source,
    });
    await expect(
      (await client(error.fetchFn).negotiate()).openRoute(error.route),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);

    const alternateNumber = await fakeBroker({
      response: async (endpoint, source) => {
        if (endpoint !== "open") return source;
        const raw = (await source.text()).replace('"v":1', '"v":1e0');
        return new Response(raw, { status: source.status, headers: new Headers(source.headers) });
      },
    });
    await expect(
      (await client(alternateNumber.fetchFn).negotiate()).openRoute(alternateNumber.route),
    ).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);
  });

  it("rejects route-open coordinate transplants and a bearer that changes identity", async () => {
    const identityId = (await sha256(AUTH_TOKEN)).slice(0, 16);
    const otherRouteId = await deriveA1BrokerRouteId({
      routeKind: "chat",
      identityId,
      collaborationServerId: OTHER_SERVER_ID,
      logicalChatId: CHAT_ID,
    });
    const transplanted = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "open"
          ? rewrittenJson(source, (body) => ({ ...body, broker_route_id: otherRouteId }))
          : source,
    });
    await expect(
      (await client(transplanted.fetchFn).negotiate()).openRoute(transplanted.route),
    ).rejects.toBeInstanceOf(A1BrokerOutcomeUnknownError);

    let bearerRead = 0;
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const changing = new A1BrokerClient({
      baseUrl: "https://broker.example",
      provider: {
        authBearer: () => (bearerRead++ === 0 ? AUTH_TOKEN.slice() : bytes(32, 0xe0)),
      },
      fetchFn,
    });
    await expect(changing.negotiate()).rejects.toBeInstanceOf(A1BrokerProtocolError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects publish frame transplants before I/O and mismatched collision receipts", async () => {
    const identityId = (await sha256(AUTH_TOKEN)).slice(0, 16);
    const badFrame = await parseA1BrokerCanonicalFrameV1(
      encodeA1EncryptedFrameV2(
        frame(identityId, {
          collaborationServerId: OTHER_SERVER_ID,
        }),
      ),
    );
    const normal = await fakeBroker();
    const normalRoute = await (await client(normal.fetchFn).negotiate()).openRoute(normal.route);
    await expect(normalRoute.publish(badFrame.canonicalFrame)).rejects.toThrow();
    expect(normal.calls).toHaveBeenCalledTimes(2);

    const collision = await fakeBroker({
      collide: true,
      response: (endpoint, source) =>
        endpoint === "publish"
          ? rewrittenJson(source, (body) => ({
              ...body,
              delivery_attempt_id: OTHER_ATTEMPT_ID,
            }))
          : source,
    });
    const collisionRoute = await (await client(collision.fetchFn).negotiate()).openRoute(
      collision.route,
    );
    await expect(collisionRoute.publish(collision.canonicalFrame)).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );
    expect(collision.calls).toHaveBeenCalledTimes(3);
  });

  it("rejects read gaps, frame transplants, wrong stores, and pages beyond the requested count", async () => {
    const gap = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const frames = body.frames as Array<Record<string, unknown>>;
              return {
                ...body,
                frames: [
                  {
                    ...frames[0],
                    cursor: { version: 1, channel_generation: 0, frame_index: 1 },
                  },
                ],
              };
            })
          : source,
    });
    const gapRoute = await (await client(gap.fetchFn).negotiate()).openRoute(gap.route);
    await expect(
      gapRoute.read({ position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 } }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);

    const identityId = (await sha256(AUTH_TOKEN)).slice(0, 16);
    const transplantedFrame = await parseA1BrokerCanonicalFrameV1(
      encodeA1EncryptedFrameV2(
        frame(identityId, {
          collaborationServerId: OTHER_SERVER_ID,
        }),
      ),
    );
    const frameTransplant = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const frames = body.frames as Array<Record<string, unknown>>;
              return {
                ...body,
                frames: [
                  {
                    ...frames[0],
                    transport_frame_digest: transplantedFrame.transportFrameDigest,
                    frame: transplantedFrame.canonicalFrame,
                  },
                ],
              };
            })
          : source,
    });
    const frameRoute = await (await client(frameTransplant.fetchFn).negotiate()).openRoute(
      frameTransplant.route,
    );
    await expect(
      frameRoute.read({ position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 } }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);

    const wrongStore = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => ({
              ...body,
              route_store_instance_id: OTHER_STORE_ID,
            }))
          : source,
    });
    const storeRoute = await (await client(wrongStore.fetchFn).negotiate()).openRoute(
      wrongStore.route,
    );
    await expect(
      storeRoute.read({ position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 } }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);

    const tooMany = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const first = (body.frames as Array<Record<string, unknown>>)[0];
              return {
                ...body,
                observed_next_frame_index: 2,
                frames: [
                  first,
                  {
                    ...first,
                    cursor: { version: 1, channel_generation: 0, frame_index: 1 },
                  },
                ],
                next_position: { version: 1, channel_generation: 0, next_frame_index: 2 },
              };
            })
          : source,
    });
    const countRoute = await (await client(tooMany.fetchFn).negotiate()).openRoute(tooMany.route);
    await expect(
      countRoute.read({
        position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
        maxFrames: 1,
      }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
  });

  it("returns exact untrusted frame evidence while the trusted reader rejects malformed inner text", async () => {
    const rawFrame = '{"not":"an A1 frame","spacing": [ 1, 2 ]}';
    const fake = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const frames = body.frames as Array<Record<string, unknown>>;
              return {
                ...body,
                frames: [{ ...frames[0], frame: rawFrame }],
              };
            })
          : source,
    });
    const route = await (await client(fake.fetchFn).negotiate()).openRoute(fake.route);
    const page = await internalA1BrokerEvidenceReader(route).read({
      position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
    });

    expect(page).toMatchObject({
      schemaVersion: 1,
      brokerRouteId: route.descriptor.brokerRouteId,
      routeStoreInstanceId: STORE_ID,
      observedNextFrameIndex: 1,
      nextPosition: { version: 1, channelGeneration: 0, nextFrameIndex: 1 },
    });
    expect(page.frames).toEqual([
      {
        cursor: { version: 1, channelGeneration: 0, frameIndex: 0 },
        deliveryAttemptId: ATTEMPT_ID,
        part: 0,
        transportFrameDigest: expect.any(String),
        rawFrame,
      },
    ]);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.frames)).toBe(true);
    expect(Object.isFrozen(page.frames[0])).toBe(true);

    await expect(
      route.read({ position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 } }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
  });

  it("bounds each untrusted raw frame by UTF-8 bytes before returning evidence", async () => {
    const atLimit = "é".repeat(A1_BROKER_MAX_RAW_FRAME_BYTES / 2);
    const accepted = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const frames = body.frames as Array<Record<string, unknown>>;
              return { ...body, frames: [{ ...frames[0], frame: atLimit }] };
            })
          : source,
    });
    const acceptedRoute = await (await client(accepted.fetchFn).negotiate()).openRoute(
      accepted.route,
    );
    const evidence = await internalA1BrokerEvidenceReader(acceptedRoute).read({
      position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
    });
    expect(evidence.frames[0]?.rawFrame).toBe(atLimit);

    const overLimit = `${atLimit}é`;
    const rejected = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const frames = body.frames as Array<Record<string, unknown>>;
              return { ...body, frames: [{ ...frames[0], frame: overLimit }] };
            })
          : source,
    });
    const rejectedRoute = await (await client(rejected.fetchFn).negotiate()).openRoute(
      rejected.route,
    );
    await expect(
      internalA1BrokerEvidenceReader(rejectedRoute).read({
        position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
  });

  it("does not route-match or recompute an evidence frame, while the trusted reader still does", async () => {
    const identityId = (await sha256(AUTH_TOKEN)).slice(0, 16);
    const transplanted = await parseA1BrokerCanonicalFrameV1(
      encodeA1EncryptedFrameV2(
        frame(identityId, {
          collaborationServerId: OTHER_SERVER_ID,
        }),
      ),
    );
    const fake = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? rewrittenJson(source, (body) => {
              const frames = body.frames as Array<Record<string, unknown>>;
              return {
                ...body,
                frames: [
                  {
                    ...frames[0],
                    transport_frame_digest: transplanted.transportFrameDigest,
                    frame: transplanted.canonicalFrame,
                  },
                ],
              };
            })
          : source,
    });
    const route = await (await client(fake.fetchFn).negotiate()).openRoute(fake.route);
    const evidence = await internalA1BrokerEvidenceReader(route).read({
      position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      maxFrames: 1,
    });
    expect(evidence.frames[0]?.rawFrame).toBe(transplanted.canonicalFrame);
    expect(evidence.frames[0]?.transportFrameDigest).toBe(transplanted.transportFrameDigest);
    await expect(
      route.read({ position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 } }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
  });

  it("rejects evidence pages without a strict, contiguous, uniquely addressable outer cursor", async () => {
    const corruptions: ReadonlyArray<(body: Record<string, unknown>) => unknown> = [
      (body) => ({ ...body, proxy_added: true }),
      (body) => {
        const frames = body.frames as Array<Record<string, unknown>>;
        return { ...body, frames: [{ ...frames[0], cursor: null }] };
      },
      (body) => {
        const frames = body.frames as Array<Record<string, unknown>>;
        return {
          ...body,
          frames: [
            {
              ...frames[0],
              cursor: { version: 1, channel_generation: 0, frame_index: 1 },
            },
          ],
        };
      },
      (body) => ({
        ...body,
        next_position: { version: 1, channel_generation: 0, next_frame_index: 0 },
      }),
      (body) => {
        const frames = body.frames as Array<Record<string, unknown>>;
        return { ...body, frames: [{ ...frames[0], delivery_attempt_id: "rda_not-canonical" }] };
      },
    ];
    for (const corrupt of corruptions) {
      const fake = await fakeBroker({
        response: (endpoint, source) =>
          endpoint === "read" ? rewrittenJson(source, corrupt) : source,
      });
      const route = await (await client(fake.fetchFn).negotiate()).openRoute(fake.route);
      await expect(
        internalA1BrokerEvidenceReader(route).read({
          position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
        }),
      ).rejects.toBeInstanceOf(A1BrokerProtocolError);
    }
  });

  it("binds evidence reads to exact route/store/status/headers and the selected read bounds", async () => {
    const identityId = (await sha256(AUTH_TOKEN)).slice(0, 16);
    const otherRouteId = await deriveA1BrokerRouteId({
      routeKind: "chat",
      identityId,
      collaborationServerId: OTHER_SERVER_ID,
      logicalChatId: CHAT_ID,
    });
    const corruptions: ReadonlyArray<(source: Response) => Promise<Response> | Response> = [
      (source) => rewrittenJson(source, (body) => ({ ...body, broker_route_id: otherRouteId })),
      (source) =>
        rewrittenJson(source, (body) => ({
          ...body,
          route_store_instance_id: OTHER_STORE_ID,
        })),
      (source) => new Response(source.body, { status: 201, headers: new Headers(source.headers) }),
      (source) =>
        withHeaders(source, (headers) => {
          headers.delete(CAPABILITY_HEADER);
        }),
    ];
    for (const corrupt of corruptions) {
      const fake = await fakeBroker({
        response: (endpoint, source) => (endpoint === "read" ? corrupt(source) : source),
      });
      const route = await (await client(fake.fetchFn).negotiate()).openRoute(fake.route);
      await expect(
        internalA1BrokerEvidenceReader(route).read({
          position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
        }),
      ).rejects.toBeInstanceOf(A1BrokerProtocolError);
    }

    const bounded = await fakeBroker();
    const boundedRoute = await (await client(bounded.fetchFn).negotiate()).openRoute(bounded.route);
    await expect(
      internalA1BrokerEvidenceReader(boundedRoute).read({
        position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
        maxFrames: 65,
      }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
    expect(bounded.calls).toHaveBeenCalledTimes(2);

    const oversized = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? new Response(new Uint8Array(8_000_001), {
              status: source.status,
              headers: new Headers(source.headers),
            })
          : source,
    });
    const oversizedRoute = await (await client(oversized.fetchFn).negotiate()).openRoute(
      oversized.route,
    );
    await expect(
      internalA1BrokerEvidenceReader(oversizedRoute).read({
        position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 },
      }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
  });

  it("bounds control and read response bytes before parsing them", async () => {
    const oversizedControl = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "capabilities"
          ? new Response(new Uint8Array(64 * 1024 + 1), {
              status: source.status,
              headers: new Headers(source.headers),
            })
          : source,
    });
    await expect(client(oversizedControl.fetchFn).negotiate()).rejects.toBeInstanceOf(
      A1BrokerProtocolError,
    );

    const oversizedRead = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "read"
          ? new Response(new Uint8Array(8_000_001), {
              status: source.status,
              headers: new Headers(source.headers),
            })
          : source,
    });
    const route = await (await client(oversizedRead.fetchFn).negotiate()).openRoute(
      oversizedRead.route,
    );
    await expect(
      route.read({ position: { version: 1, channelGeneration: 0, nextFrameIndex: 0 } }),
    ).rejects.toBeInstanceOf(A1BrokerProtocolError);
  });

  it("reports mutation transport and response-stream failures as unknown without retrying", async () => {
    const bearerText = `Bearer ${toHex(AUTH_TOKEN)}`;
    const failedFetch = await fakeBroker({
      response: (endpoint, source) => {
        if (endpoint === "publish") throw new Error(bearerText);
        return source;
      },
    });
    const failedFetchRoute = await (await client(failedFetch.fetchFn).negotiate()).openRoute(
      failedFetch.route,
    );
    const fetchError = await rejected(failedFetchRoute.publish(failedFetch.canonicalFrame));
    expect(fetchError).toBeInstanceOf(A1BrokerOutcomeUnknownError);
    expect(fetchError).not.toHaveProperty("cause");
    expect(String(fetchError)).not.toContain(toHex(AUTH_TOKEN));
    expect(failedFetch.calls).toHaveBeenCalledTimes(3);

    const failedStream = await fakeBroker({
      response: (endpoint, source) => {
        if (endpoint !== "publish") return source;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(bearerText));
            },
          }),
          { status: source.status, headers: new Headers(source.headers) },
        );
      },
    });
    const failedStreamRoute = await (await client(failedStream.fetchFn).negotiate()).openRoute(
      failedStream.route,
    );
    const streamError = await rejected(failedStreamRoute.publish(failedStream.canonicalFrame));
    expect(streamError).toBeInstanceOf(A1BrokerOutcomeUnknownError);
    expect(streamError).not.toHaveProperty("cause");
    expect(String(streamError)).not.toContain(toHex(AUTH_TOKEN));
    expect(failedStream.calls).toHaveBeenCalledTimes(3);
  });

  it("never reflects malformed remote bodies or bearer-provider errors", async () => {
    const bearerText = `Bearer ${toHex(AUTH_TOKEN)}`;
    const malformed = await fakeBroker({
      response: (endpoint, source) =>
        endpoint === "capabilities"
          ? new Response(`{${JSON.stringify(bearerText)}`, {
              status: source.status,
              headers: new Headers(source.headers),
            })
          : source,
    });
    const malformedError = await rejected(client(malformed.fetchFn).negotiate());
    expect(malformedError).toBeInstanceOf(A1BrokerProtocolError);
    expect(malformedError).not.toHaveProperty("cause");
    expect(String(malformedError)).not.toContain(toHex(AUTH_TOKEN));

    const providerError = await rejected(
      new A1BrokerClient({
        baseUrl: "https://broker.example",
        provider: {
          authBearer() {
            throw new Error(bearerText);
          },
        },
        fetchFn: vi.fn() as unknown as typeof fetch,
      }).negotiate(),
    );
    expect(providerError).toBeInstanceOf(A1BrokerProtocolError);
    expect(providerError).not.toHaveProperty("cause");
    expect(String(providerError)).not.toContain(toHex(AUTH_TOKEN));
  });
});
