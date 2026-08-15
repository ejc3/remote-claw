import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  type A1EncryptedFrameV2,
  a1BrokerGenerationManifestDigest,
  base64urlEncode,
  deriveA1BrokerRouteId,
  deriveA1ChatToken,
  toHex,
} from "@remote-claw/clawsec";
import { afterEach, describe, expect, it } from "vitest";
import { A1BrokerError, type A1RouteCoordinates } from "../../lib/broker/a1-contract";
import { A1SqliteBackend } from "../../lib/broker/a1-sqlite";
import { dbFileName, FileDbLocator, SqliteMultiBackend } from "../../lib/broker/sqlite-multi";
import { TursoCloudDbLocator } from "../../lib/broker/turso-cloud-locator";
import { uniqueIdentity } from "../helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function id(prefix: "rcs_" | "rcl_" | "rda_", start: number): string {
  return `${prefix}${base64urlEncode(bytes(16, start))}`;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rc-a1-sqlite-"));
  dirs.push(dir);
  const locator = new FileDbLocator(dir);
  const identity = await uniqueIdentity();
  const collaborationServerId = id("rcs_", 0x10);
  const logicalChatId = id("rcl_", 0x30);
  const route = {
    routeKind: "chat" as const,
    identityId: identity.identityId,
    collaborationServerId,
    logicalChatId,
  };
  const coordinates: A1RouteCoordinates = {
    brokerRouteId: await deriveA1BrokerRouteId(route),
    identityIdHex: toHex(identity.identityId),
    route,
    routeKind: "chat",
    collaborationServerId,
    logicalChatId,
    routeToken: await deriveA1ChatToken(identity.identityId, collaborationServerId, logicalChatId),
  };
  return { dir, locator, identity, coordinates };
}

function frame(
  coordinates: A1RouteCoordinates,
  attemptStart: number,
  change = 0,
): A1EncryptedFrameV2 {
  return {
    v: 2,
    identityId: coordinates.route.identityId,
    collaborationServerId: coordinates.collaborationServerId,
    logicalChatId: coordinates.logicalChatId,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: `source.msg-${attemptStart}`,
    deliveryAttemptId: id("rda_", attemptStart),
    clientMsgId: `client:proposal-${attemptStart}`,
    keyEpoch: 0,
    salt: bytes(32, 0x50 + change),
    nonce: bytes(12, 0x70 + change),
    ct: bytes(16, 0x90 + change),
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
    hostSignature: null,
  };
}

async function opened(input?: Awaited<ReturnType<typeof fixture>>) {
  const f = input ?? (await fixture());
  const backend = new A1SqliteBackend(f.locator);
  const receipt = await backend.openRoute(f.coordinates, null);
  return { ...f, backend, receipt };
}

describe("selected-A1 SQLite broker", () => {
  it("maps selected-A1 control stores to the observable Turso c code", () => {
    const locator = new TursoCloudDbLocator({
      apiToken: "api",
      org: "org",
      group: "group",
      authToken: "auth",
      scope: "dev",
      fetchImpl: async () => new Response(null, { status: 500 }),
    });
    expect(locator.config("ctl:a1:route-token").url).toMatch(/^libsql:\/\/rc-dev-c-/);
  });

  it("atomically creates one pristine genesis and coalesces racing opens", async () => {
    const f = await fixture();
    const backends = Array.from({ length: 12 }, () => new A1SqliteBackend(f.locator));
    const receipts = await Promise.all(
      backends.map((backend) => backend.openRoute(f.coordinates, null)),
    );

    expect(receipts.filter((receipt) => receipt.disposition === "created")).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.routeStoreInstanceId))).toEqual(
      new Set([receipts[0]?.routeStoreInstanceId]),
    );
    for (const receipt of receipts) {
      expect(receipt.genesis).toEqual({
        channel_generation: 0,
        state: "open",
        frame_count: null,
        next_generation: null,
        manifest_digest: null,
        next_frame_index: 0,
      });
      expect(receipt.generation).toEqual(receipt.genesis);
      expect(receipt.observedNextFrameIndex).toBe(0);
      expect(receipt.routeStoreInstanceId).toMatch(/^rbsi_[A-Za-z0-9_-]{22}$/);
    }
  });

  it("retries a catalog-wide route-store ID collision without aliasing either route", async () => {
    const f = await fixture();
    const firstEntropy = new Uint8Array(16).fill(0xa1);
    const secondEntropy = new Uint8Array(16).fill(0xb2);
    const first = await new A1SqliteBackend(f.locator, createClient, () =>
      firstEntropy.slice(),
    ).openRoute(f.coordinates, null);
    const logicalChatId = id("rcl_", 0xe1);
    const route = {
      routeKind: "chat" as const,
      identityId: f.identity.identityId,
      collaborationServerId: f.coordinates.collaborationServerId,
      logicalChatId,
    };
    const coordinates: A1RouteCoordinates = {
      brokerRouteId: await deriveA1BrokerRouteId(route),
      identityIdHex: f.coordinates.identityIdHex,
      route,
      routeKind: "chat",
      collaborationServerId: route.collaborationServerId,
      logicalChatId,
      routeToken: await deriveA1ChatToken(
        route.identityId,
        route.collaborationServerId,
        logicalChatId,
      ),
    };
    let calls = 0;
    const second = await new A1SqliteBackend(f.locator, createClient, () => {
      calls++;
      return (calls === 1 ? firstEntropy : secondEntropy).slice();
    }).openRoute(coordinates, null);

    expect(calls).toBe(2);
    expect(second.routeStoreInstanceId).not.toBe(first.routeStoreInstanceId);
    await expect(
      new A1SqliteBackend(f.locator).openRoute(f.coordinates, first.routeStoreInstanceId),
    ).resolves.toMatchObject({ routeStoreInstanceId: first.routeStoreInstanceId });
    await expect(
      new A1SqliteBackend(f.locator).openRoute(coordinates, second.routeStoreInstanceId),
    ).resolves.toMatchObject({ routeStoreInstanceId: second.routeStoreInstanceId });
  });

  it("bounds route-store ID collision exhaustion without reserving a route", async () => {
    const f = await fixture();
    const firstEntropy = new Uint8Array(16).fill(0xa1);
    const secondEntropy = new Uint8Array(16).fill(0xb2);
    const first = await new A1SqliteBackend(f.locator, createClient, () =>
      firstEntropy.slice(),
    ).openRoute(f.coordinates, null);
    const logicalChatId = id("rcl_", 0xe2);
    const route = {
      routeKind: "chat" as const,
      identityId: f.identity.identityId,
      collaborationServerId: f.coordinates.collaborationServerId,
      logicalChatId,
    };
    const coordinates: A1RouteCoordinates = {
      brokerRouteId: await deriveA1BrokerRouteId(route),
      identityIdHex: f.coordinates.identityIdHex,
      route,
      routeKind: "chat",
      collaborationServerId: route.collaborationServerId,
      logicalChatId,
      routeToken: await deriveA1ChatToken(
        route.identityId,
        route.collaborationServerId,
        logicalChatId,
      ),
    };
    let calls = 0;
    const exhausted = new A1SqliteBackend(f.locator, createClient, () => {
      calls++;
      return firstEntropy.slice();
    });

    await expect(exhausted.openRoute(coordinates, null)).rejects.toSatisfy(
      (error: unknown) =>
        A1BrokerError.is(error) && error.status === 507 && error.code === "counter_exhausted",
    );
    expect(calls).toBe(16);
    expect(existsSync(join(f.dir, dbFileName(coordinates.routeToken)))).toBe(false);

    const recovered = await new A1SqliteBackend(f.locator, createClient, () =>
      secondEntropy.slice(),
    ).openRoute(coordinates, null);
    expect(recovered.disposition).toBe("created");
    expect(recovered.routeStoreInstanceId).not.toBe(first.routeStoreInstanceId);
  });

  it("scopes identical attempt/part coordinates to the exact route", async () => {
    const first = await opened();
    const logicalChatId = id("rcl_", 0xe3);
    const route = {
      routeKind: "chat" as const,
      identityId: first.identity.identityId,
      collaborationServerId: first.coordinates.collaborationServerId,
      logicalChatId,
    };
    const secondCoordinates: A1RouteCoordinates = {
      brokerRouteId: await deriveA1BrokerRouteId(route),
      identityIdHex: first.coordinates.identityIdHex,
      route,
      routeKind: "chat",
      collaborationServerId: route.collaborationServerId,
      logicalChatId,
      routeToken: await deriveA1ChatToken(
        route.identityId,
        route.collaborationServerId,
        logicalChatId,
      ),
    };
    const secondBackend = new A1SqliteBackend(first.locator);
    const second = await secondBackend.openRoute(secondCoordinates, null);
    const firstInput = {
      route: first.coordinates,
      expectedRouteStoreInstanceId: first.receipt.routeStoreInstanceId,
      frame: frame(first.coordinates, 0x60),
    };
    const secondInput = {
      route: secondCoordinates,
      expectedRouteStoreInstanceId: second.routeStoreInstanceId,
      frame: frame(secondCoordinates, 0x60),
    };

    await expect(first.backend.relay(firstInput)).resolves.toMatchObject({
      kind: "stored",
      disposition: "inserted",
      cursor: { channel_generation: 0, frame_index: 0 },
    });
    await expect(secondBackend.relay(secondInput)).resolves.toMatchObject({
      kind: "stored",
      disposition: "inserted",
      cursor: { channel_generation: 0, frame_index: 0 },
    });
    await expect(
      first.backend.relay({ ...firstInput, frame: frame(first.coordinates, 0x60, 1) }),
    ).resolves.toMatchObject({ kind: "collision" });
    await expect(secondBackend.relay(secondInput)).resolves.toMatchObject({
      kind: "stored",
      disposition: "exact_retry",
      cursor: { channel_generation: 0, frame_index: 0 },
    });
  });

  it("returns one immutable cursor for concurrent exact retry across restart", async () => {
    const f = await opened();
    const input = {
      route: f.coordinates,
      expectedRouteStoreInstanceId: f.receipt.routeStoreInstanceId,
      frame: frame(f.coordinates, 1),
    };
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 === 0 ? f.backend : new A1SqliteBackend(f.locator)).relay(input),
      ),
    );
    expect(
      results.filter((result) => result.kind === "stored" && result.disposition === "inserted"),
    ).toHaveLength(1);
    expect(
      new Set(
        results.map((result) =>
          result.kind === "stored"
            ? `${result.cursor.channel_generation}:${result.cursor.frame_index}`
            : "collision",
        ),
      ),
    ).toEqual(new Set(["0:0"]));

    const restarted = new A1SqliteBackend(new FileDbLocator(f.dir));
    await expect(restarted.relay(input)).resolves.toMatchObject({
      kind: "stored",
      disposition: "exact_retry",
      cursor: { channel_generation: 0, frame_index: 0 },
    });
  });

  it("latches only the first changed digest while preserving the original retry", async () => {
    const f = await opened();
    const base = frame(f.coordinates, 2);
    const common = {
      route: f.coordinates,
      expectedRouteStoreInstanceId: f.receipt.routeStoreInstanceId,
    };
    const original = await f.backend.relay({ ...common, frame: base });
    expect(original).toMatchObject({ kind: "stored", disposition: "inserted" });

    const first = await f.backend.relay({ ...common, frame: frame(f.coordinates, 2, 1) });
    const second = await new A1SqliteBackend(f.locator).relay({
      ...common,
      frame: frame(f.coordinates, 2, 2),
    });
    expect(first).toMatchObject({ kind: "collision", originalCursor: { frame_index: 0 } });
    expect(second).toMatchObject({
      kind: "collision",
      firstConflictingTransportFrameDigest:
        first.kind === "collision" ? first.firstConflictingTransportFrameDigest : "",
    });
    if (first.kind !== "collision" || second.kind !== "collision") throw new Error("bad fixture");
    expect(second.conflictingTransportFrameDigest).not.toBe(
      second.firstConflictingTransportFrameDigest,
    );
    await expect(f.backend.relay({ ...common, frame: base })).resolves.toMatchObject({
      kind: "stored",
      disposition: "exact_retry",
      cursor: { channel_generation: 0, frame_index: 0 },
    });
  });

  it("seals atomically, advances empty/drained reads, and keeps old retries on the old cursor", async () => {
    const f = await opened();
    const input = {
      route: f.coordinates,
      expectedRouteStoreInstanceId: f.receipt.routeStoreInstanceId,
      frame: frame(f.coordinates, 3),
    };
    await f.backend.relay(input);
    const transition = await f.backend.seal(f.coordinates, f.receipt.routeStoreInstanceId, 0);
    expect(transition.sealed.manifest_digest).toBe(
      await a1BrokerGenerationManifestDigest({
        brokerRouteId: f.coordinates.brokerRouteId,
        channelGeneration: 0,
        frameCount: 1,
        nextGeneration: 1,
        state: "sealed",
      }),
    );
    await expect(
      new A1SqliteBackend(new FileDbLocator(f.dir)).seal(
        f.coordinates,
        f.receipt.routeStoreInstanceId,
        0,
      ),
    ).resolves.toEqual(transition);
    await expect(f.backend.relay(input)).resolves.toMatchObject({
      disposition: "exact_retry",
      cursor: { channel_generation: 0, frame_index: 0 },
    });
    await expect(
      f.backend.subscribe(
        f.coordinates,
        f.receipt.routeStoreInstanceId,
        { version: 1, channel_generation: 0, next_frame_index: 0 },
        64,
      ),
    ).resolves.toMatchObject({
      generation: { state: "sealed", frame_count: 1, next_generation: 1 },
      nextPosition: { channel_generation: 1, next_frame_index: 0 },
      atLiveTail: false,
      frames: [{ delivery_attempt_id: input.frame.deliveryAttemptId, part: 0 }],
    });

    const reopened = await new A1SqliteBackend(f.locator).openRoute(
      f.coordinates,
      f.receipt.routeStoreInstanceId,
    );
    expect(reopened.genesis).toMatchObject({ state: "sealed", frame_count: 1 });
    expect(reopened.generation).toMatchObject({
      channel_generation: 1,
      state: "open",
      next_frame_index: 0,
    });

    await f.backend.seal(f.coordinates, f.receipt.routeStoreInstanceId, 1);
    await expect(f.backend.seal(f.coordinates, f.receipt.routeStoreInstanceId, 0)).resolves.toEqual(
      {
        sealed: transition.sealed,
        successor: {
          ...transition.successor,
          state: "sealed",
          frame_count: 0,
          next_generation: 2,
          manifest_digest: await a1BrokerGenerationManifestDigest({
            brokerRouteId: f.coordinates.brokerRouteId,
            channelGeneration: 1,
            frameCount: 0,
            nextGeneration: 2,
            state: "sealed",
          }),
        },
      },
    );
  });

  it("paginates one sampled generation without inventing a tail", async () => {
    const f = await opened();
    for (const attempt of [4, 5, 6]) {
      await f.backend.relay({
        route: f.coordinates,
        expectedRouteStoreInstanceId: f.receipt.routeStoreInstanceId,
        frame: frame(f.coordinates, attempt),
      });
    }
    const first = await f.backend.subscribe(
      f.coordinates,
      f.receipt.routeStoreInstanceId,
      { version: 1, channel_generation: 0, next_frame_index: 0 },
      2,
    );
    expect(first.frames).toHaveLength(2);
    expect(first.observedNextFrameIndex).toBe(3);
    expect(first.nextPosition).toEqual({
      version: 1,
      channel_generation: 0,
      next_frame_index: 2,
    });
    expect(first.atLiveTail).toBe(false);
    const second = await f.backend.subscribe(
      f.coordinates,
      f.receipt.routeStoreInstanceId,
      first.nextPosition,
      2,
    );
    expect(second.frames).toHaveLength(1);
    expect(second.atLiveTail).toBe(true);
  });

  it("auto-rolls a generation at the exact 4096-frame boundary", async () => {
    const f = await opened();
    const path = join(f.dir, dbFileName(f.coordinates.routeToken));
    const client = createClient({ url: `file:${path}` });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute({
        sql: `WITH RECURSIVE n(i) AS (
                VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 4095
              )
              INSERT INTO a1_frames
                (channel_generation, frame_index, delivery_attempt_id, part,
                 transport_digest, frame, created_at)
              SELECT 0, i, 'bulk-' || i, 0, 'bulk-digest-' || i, '{}', ? FROM n`,
        args: [Date.now()],
      });
      await client.execute(
        `INSERT INTO a1_attempt_parts
           (delivery_attempt_id, part, channel_generation, frame_index, transport_digest, created_at)
         SELECT delivery_attempt_id, part, channel_generation, frame_index, transport_digest, created_at
           FROM a1_frames`,
      );
      await client.execute(
        "UPDATE a1_generations SET next_frame_index = 4096 WHERE channel_generation = 0",
      );
    } finally {
      client.close();
    }
    const result = await f.backend.relay({
      route: f.coordinates,
      expectedRouteStoreInstanceId: f.receipt.routeStoreInstanceId,
      frame: frame(f.coordinates, 9),
    });
    expect(result).toMatchObject({
      kind: "stored",
      disposition: "inserted",
      cursor: { channel_generation: 1, frame_index: 0 },
    });
    const reopened = await f.backend.openRoute(f.coordinates, f.receipt.routeStoreInstanceId);
    expect(reopened.genesis).toMatchObject({
      state: "sealed",
      frame_count: 4096,
      next_generation: 1,
    });
    expect(reopened.generation).toMatchObject({
      channel_generation: 1,
      state: "open",
      next_frame_index: 1,
    });
  });

  it("caps the irreversible A1 catalog at 4096 routes per bearer identity", async () => {
    const f = await opened();
    const catalogPath = join(f.dir, dbFileName("__remote-claw-a1-route-catalog-v1__"));
    const catalog = createClient({ url: `file:${catalogPath}` });
    try {
      await catalog.execute({
        sql: `WITH RECURSIVE n(i) AS (
                VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 4095
              )
              INSERT INTO a1_route_catalog
                (broker_route_id, identity_id, collaboration_server_id, route_kind,
                 logical_chat_id, route_token, store_instance_id, capabilities_digest,
                 state, created_at, updated_at)
              SELECT 'fake-route-' || i, ?, 'fake-server', 'scope_bus', NULL,
                     'fake-token-' || i, 'fake-store-' || i, 'fake-digest',
                     'lost', ?, ? FROM n`,
        args: [f.coordinates.identityIdHex, Date.now(), Date.now()],
      });
    } finally {
      catalog.close();
    }
    const logicalChatId = id("rcl_", 0xe0);
    const route = {
      routeKind: "chat" as const,
      identityId: f.identity.identityId,
      collaborationServerId: f.coordinates.collaborationServerId,
      logicalChatId,
    };
    const coordinates: A1RouteCoordinates = {
      brokerRouteId: await deriveA1BrokerRouteId(route),
      identityIdHex: f.coordinates.identityIdHex,
      route,
      routeKind: "chat",
      collaborationServerId: route.collaborationServerId,
      logicalChatId,
      routeToken: await deriveA1ChatToken(
        route.identityId,
        route.collaborationServerId,
        logicalChatId,
      ),
    };
    const unopenedPath = join(f.dir, dbFileName(coordinates.routeToken));
    await expect(new A1SqliteBackend(f.locator).openRoute(coordinates, null)).rejects.toMatchObject(
      {
        code: "counter_exhausted",
        status: 507,
      },
    );
    expect(existsSync(unopenedPath)).toBe(false);
  });

  it("reconstructs a lost A1 catalog only from an intact store with the pinned rbsi", async () => {
    const f = await opened();
    const catalogPath = join(f.dir, dbFileName("__remote-claw-a1-route-catalog-v1__"));
    await f.locator.dropStored?.(catalogPath);
    expect(existsSync(catalogPath)).toBe(false);

    const recovered = await new A1SqliteBackend(new FileDbLocator(f.dir)).openRoute(
      f.coordinates,
      f.receipt.routeStoreInstanceId,
    );
    expect(recovered).toMatchObject({
      disposition: "existing",
      routeStoreInstanceId: f.receipt.routeStoreInstanceId,
      generation: { channel_generation: 0, state: "open" },
    });
    expect(existsSync(catalogPath)).toBe(true);
  });

  it("resumes the catalog-provisioning/physical-commit split without rotating rbsi", async () => {
    const f = await opened();
    const catalogPath = join(f.dir, dbFileName("__remote-claw-a1-route-catalog-v1__"));
    const catalog = createClient({ url: `file:${catalogPath}` });
    try {
      await catalog.execute({
        sql: `UPDATE a1_route_catalog SET state = 'provisioning'
               WHERE broker_route_id = ?`,
        args: [f.coordinates.brokerRouteId],
      });
    } finally {
      catalog.close();
    }

    const recovered = await new A1SqliteBackend(new FileDbLocator(f.dir)).openRoute(
      f.coordinates,
      f.receipt.routeStoreInstanceId,
    );
    expect(recovered).toMatchObject({
      disposition: "existing",
      routeStoreInstanceId: f.receipt.routeStoreInstanceId,
      genesis: { channel_generation: 0, state: "open" },
      generation: { channel_generation: 0, state: "open" },
      observedNextFrameIndex: 0,
    });
  });

  it("budgets the complete encoded read response and never materializes a 64-frame overshoot", async () => {
    const f = await opened();
    for (const attempt of [12, 13]) {
      await f.backend.relay({
        route: f.coordinates,
        expectedRouteStoreInstanceId: f.receipt.routeStoreInstanceId,
        frame: { ...frame(f.coordinates, attempt), ct: bytes(3_000_000, attempt) },
      });
    }
    const page = await f.backend.subscribe(
      f.coordinates,
      f.receipt.routeStoreInstanceId,
      { version: 1, channel_generation: 0, next_frame_index: 0 },
      64,
    );
    expect(page.frames).toHaveLength(1);
    expect(page.nextPosition.next_frame_index).toBe(1);
    expect(page.atLiveTail).toBe(false);
  });

  it("latches a committed route lost and never lets A0 retention select it", async () => {
    const f = await opened();
    const path = join(f.dir, dbFileName(f.coordinates.routeToken));
    expect(existsSync(path)).toBe(true);
    const a0 = new SqliteMultiBackend(f.locator);
    await expect(a0.sweep(0)).resolves.toBe(0);
    expect(existsSync(path)).toBe(true);

    await f.locator.dropStored?.(path);
    await expect(
      new A1SqliteBackend(f.locator).openRoute(f.coordinates, f.receipt.routeStoreInstanceId),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });
    expect(existsSync(path)).toBe(false);
    await expect(
      new A1SqliteBackend(f.locator).openRoute(f.coordinates, null),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });
    expect(existsSync(path)).toBe(false);
  });
});
