import { describe, expect, it } from "vitest";
import {
  type A1BrokerRoute,
  type A1EncryptedFrameV2,
  type A1FrameHeaderV2,
  A1WireError,
  a1AttemptHeaderDigest,
  a1AuthenticatedPartDigest,
  a1CanonicalMessageDigest,
  a1HostSignaturePayload,
  a1HostSignedRecordDigest,
  a1PlaneForKind,
  a1TransportFrameDigest,
  assertA1FrameMatchesRoute,
  canonicalA1Aad,
  canonicalA1BrokerRouteAddressPreimage,
  canonicalA1BrokerRouteIdPreimage,
  canonicalA1StableLogicalHeader,
  deriveA1BrokerRouteId,
  deriveA1ChatAddress,
  deriveA1ChatKeys,
  deriveA1ChatToken,
  deriveA1MessageKey,
  deriveA1ScopeAddress,
  deriveA1ScopeToken,
  deriveA1ServerControlAddress,
  deriveA1ServerControlKeys,
  deriveA1ServerControlToken,
  encodeA1EncryptedFrameV2,
  encodeA1EncryptedFrameV2Bytes,
  normalizedA1TransportFrameBytes,
  openA1FramePart,
  parseA1EncryptedFrameV2,
  sealA1FramePartWith,
} from "./a1-wire.js";
import { base64urlDecode, base64urlEncode } from "./base64url.js";
import { concatBytes, utf8 } from "./bytes.js";

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

const IDENTITY_ID = bytes(16, 0);
const SERVER_ID = "rcs_EBESExQVFhcYGRobHB0eHw";
const CHAT_ID = "rcl_ICEiIyQlJicoKSorLC0uLw";
const ATTEMPT_ID = "rda_MDEyMzQ1Njc4OTo7PD0-Pw";
const SECOND_ATTEMPT_ID = "rda_QEFCQ0RFRkdISUpLTE1OTw";
const CHAT_ROUTE_ID = "rcr_rvrPIEXeJZ-TQvkWgfyYJgMl99GFWA4_reIVFFBzsec";
const PLAINTEXT = utf8("hello A1 wire 🌐");
const SALT = bytes(32, 0x80);
const NONCE = bytes(12, 0xa0);

function inboundUserHeader(overrides: Partial<A1FrameHeaderV2> = {}): A1FrameHeaderV2 {
  return {
    v: 2,
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    dir: "in",
    recordKind: "user",
    seq: null,
    msgId: "source.msg-1",
    deliveryAttemptId: ATTEMPT_ID,
    clientMsgId: "client:proposal-1",
    keyEpoch: 0,
    part: 0,
    parts: 1,
    serverKeyGeneration: null,
    hostSignerIdentityKeyId: null,
    hostScopeCertificateId: null,
    hostSignatureSequence: null,
    ...overrides,
  };
}

function outboundHeader(overrides: Partial<A1FrameHeaderV2> = {}): A1FrameHeaderV2 {
  return inboundUserHeader({
    dir: "out",
    recordKind: "assistant",
    seq: 7,
    clientMsgId: null,
    serverKeyGeneration: 3,
    hostSignerIdentityKeyId: "key.server-3",
    hostScopeCertificateId: "cert.scope-3",
    hostSignatureSequence: 41,
    ...overrides,
  });
}

function dummyFrame(header: A1FrameHeaderV2): A1EncryptedFrameV2 {
  return {
    ...header,
    salt: SALT,
    nonce: NONCE,
    ct: bytes(16, 0xb0),
    hostSignature: header.dir === "out" ? bytes(64, 1) : null,
  };
}

function route(
  routeKind: "scope_bus" | "server_control",
  overrides: Partial<A1BrokerRoute> = {},
): A1BrokerRoute {
  return {
    routeKind,
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    logicalChatId: null,
    ...overrides,
  } as A1BrokerRoute;
}

function chatRoute(overrides: Partial<A1BrokerRoute> = {}): A1BrokerRoute {
  return {
    routeKind: "chat",
    identityId: IDENTITY_ID,
    collaborationServerId: SERVER_ID,
    logicalChatId: CHAT_ID,
    ...overrides,
  } as A1BrokerRoute;
}

const LOCKED_WIRE =
  '{"v":2,"identity_id":"000102030405060708090a0b0c0d0e0f","collaboration_server_id":"rcs_EBESExQVFhcYGRobHB0eHw","logical_chat_id":"rcl_ICEiIyQlJicoKSorLC0uLw","dir":"in","record_kind":"user","seq":null,"msg_id":"source.msg-1","delivery_attempt_id":"rda_MDEyMzQ1Njc4OTo7PD0-Pw","client_msg_id":"client:proposal-1","key_epoch":0,"salt":"gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8","nonce":"oKGio6Slpqeoqaqr","ct":"ze91G3BHpSxueylTfPPxtA0yDdPzIfPxUKHl30_Pghxeaw","part":0,"parts":1,"server_key_generation":null,"host_signer_identity_key_id":null,"host_scope_certificate_id":null,"host_signature_sequence":null,"host_signature":null}';

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function noncanonicalTailAlias(canonical: string): string {
  const last = canonical.at(-1);
  const index = last === undefined ? -1 : BASE64URL_ALPHABET.indexOf(last);
  if (index < 0 || canonical.length % 4 === 0 || index + 1 >= BASE64URL_ALPHABET.length) {
    throw new Error("fixture has no tail-bit alias");
  }
  return `${canonical.slice(0, -1)}${BASE64URL_ALPHABET[index + 1]}`;
}

async function vectorKeys() {
  return deriveA1ChatKeys(
    bytes(32, 0x21),
    bytes(32, 0x41),
    bytes(32, 0x61),
    IDENTITY_ID,
    SERVER_ID,
    CHAT_ID,
  );
}

describe("selected-A1 route and KDF vectors", () => {
  it("locks the three non-aliasing addresses, tokens, and physical route IDs", async () => {
    expect([
      base64urlEncode(canonicalA1BrokerRouteAddressPreimage(route("scope_bus"))),
      base64urlEncode(canonicalA1BrokerRouteAddressPreimage(route("server_control"))),
      base64urlEncode(canonicalA1BrokerRouteAddressPreimage(chatRoute())),
      base64urlEncode(canonicalA1BrokerRouteIdPreimage(route("scope_bus"))),
      base64urlEncode(canonicalA1BrokerRouteIdPreimage(route("server_control"))),
      base64urlEncode(canonicalA1BrokerRouteIdPreimage(chatRoute())),
    ]).toEqual([
      "AAAAFHJlbW90ZS1jbGF3L2ExL3Njb3BlAAAAEAABAgMEBQYHCAkKCwwNDg8AAAAacmNzX0VCRVNFeFFWRmhjWUdSb2JIQjBlSHc",
      "AAAAHXJlbW90ZS1jbGF3L2ExL3NlcnZlci1jb250cm9sAAAAEAABAgMEBQYHCAkKCwwNDg8AAAAacmNzX0VCRVNFeFFWRmhjWUdSb2JIQjBlSHc",
      "AAAAE3JlbW90ZS1jbGF3L2ExL2NoYXQAAAAQAAECAwQFBgcICQoLDA0ODwAAABpyY3NfRUJFU0V4UVZGaGNZR1JvYkhCMGVIdwAAABpyY2xfSUNFaUl5UWxKaWNvS1NvckxDMHVMdw",
      "AAAAHnJlbW90ZS1jbGF3L2ExL2Jyb2tlci1yb3V0ZS92MQAAABAAAQIDBAUGBwgJCgsMDQ4PAAAAGnJjc19FQkVTRXhRVkZoY1lHUm9iSEIwZUh3AAAACXNjb3BlX2J1cwA",
      "AAAAHnJlbW90ZS1jbGF3L2ExL2Jyb2tlci1yb3V0ZS92MQAAABAAAQIDBAUGBwgJCgsMDQ4PAAAAGnJjc19FQkVTRXhRVkZoY1lHUm9iSEIwZUh3AAAADnNlcnZlcl9jb250cm9sAA",
      "AAAAHnJlbW90ZS1jbGF3L2ExL2Jyb2tlci1yb3V0ZS92MQAAABAAAQIDBAUGBwgJCgsMDQ4PAAAAGnJjc19FQkVTRXhRVkZoY1lHUm9iSEIwZUh3AAAABGNoYXQBAAAAGnJjbF9JQ0VpSXlRbEppY29LU29yTEMwdUx3",
    ]);
    expect(await deriveA1ScopeAddress(IDENTITY_ID, SERVER_ID)).toBe(
      "syrycHHTDlS988l0NWYFeOpbK0xsHndbqR25iAeVB7E",
    );
    expect(await deriveA1ServerControlAddress(IDENTITY_ID, SERVER_ID)).toBe(
      "xf7z2BxSeHn9l6jlEwRQaoE8DyQFCJG71heo9ooKXMM",
    );
    expect(await deriveA1ChatAddress(IDENTITY_ID, SERVER_ID, CHAT_ID)).toBe(
      "5oI0wx34h-InDx6QeKQX994BVd1fe-SLHIhH3gLGwc8",
    );
    expect(await deriveA1ScopeToken(IDENTITY_ID, SERVER_ID)).toBe(
      "bus:a1:syrycHHTDlS988l0NWYFeOpbK0xsHndbqR25iAeVB7E",
    );
    expect(await deriveA1ServerControlToken(IDENTITY_ID, SERVER_ID)).toBe(
      "ctl:a1:xf7z2BxSeHn9l6jlEwRQaoE8DyQFCJG71heo9ooKXMM",
    );
    expect(await deriveA1ChatToken(IDENTITY_ID, SERVER_ID, CHAT_ID)).toBe(
      "sess:a1:5oI0wx34h-InDx6QeKQX994BVd1fe-SLHIhH3gLGwc8",
    );
    expect(await deriveA1BrokerRouteId(route("scope_bus"))).toBe(
      "rcr_PiK9eO4dC7KKoRfNEhNLyFDdk3QE43pBoQBs8-EP6V4",
    );
    expect(await deriveA1BrokerRouteId(route("server_control"))).toBe(
      "rcr_WSckPEtq2llPVN1N2Ppl97c6zIn5KToBadXO_5nhRpw",
    );
    expect(await deriveA1BrokerRouteId(chatRoute())).toBe(CHAT_ROUTE_ID);
  });

  it("snapshots and rejects malformed full routes in synchronous preimage helpers", () => {
    const identityId = IDENTITY_ID.slice();
    const selected = chatRoute({ identityId });
    const addressBytes = canonicalA1BrokerRouteAddressPreimage(selected);
    const routeIdBytes = canonicalA1BrokerRouteIdPreimage(selected);
    identityId.fill(0xff);
    expect(base64urlEncode(addressBytes)).toBe(
      "AAAAE3JlbW90ZS1jbGF3L2ExL2NoYXQAAAAQAAECAwQFBgcICQoLDA0ODwAAABpyY3NfRUJFU0V4UVZGaGNZR1JvYkhCMGVIdwAAABpyY2xfSUNFaUl5UWxKaWNvS1NvckxDMHVMdw",
    );
    expect(base64urlEncode(routeIdBytes)).toBe(
      "AAAAHnJlbW90ZS1jbGF3L2ExL2Jyb2tlci1yb3V0ZS92MQAAABAAAQIDBAUGBwgJCgsMDQ4PAAAAGnJjc19FQkVTRXhRVkZoY1lHUm9iSEIwZUh3AAAABGNoYXQBAAAAGnJjbF9JQ0VpSXlRbEppY29LU29yTEMwdUx3",
    );
    expect(() =>
      canonicalA1BrokerRouteAddressPreimage({
        ...chatRoute(),
        logicalChatId: null,
      } as A1BrokerRoute),
    ).toThrow(/logicalChatId/);
  });

  it("locks all chat and server-control plane KDF outputs", async () => {
    const chat = await vectorKeys();
    const control = await deriveA1ServerControlKeys(
      bytes(32, 0x41),
      bytes(32, 0x61),
      IDENTITY_ID,
      SERVER_ID,
    );
    expect(base64urlEncode(chat.contentKey)).toBe("F7g95Ps_V6lnBccUT2XAcn05gyJ27b89CDjlbOXowQw");
    expect(base64urlEncode(chat.controlKey)).toBe("_HMhvqjxDKXcs0BIK1YKVDCE6wUNexdqRQjrtbvNjbg");
    expect(base64urlEncode(chat.metaKey)).toBe("U4Ar4PZ-UI2TLp6urbQm4dudQ8m0VR9bPLfAkU835YE");
    expect(base64urlEncode(control.inboundKey)).toBe("-LC3F_q75H7MaowgmR9QAMuJZIvwK-2DvEgr-fY-hps");
    expect(base64urlEncode(control.outboundKey)).toBe(
      "UuzmEnkfXjRW8NMAhr2JAtOqWsjcRJlVFuDpt6kXBKM",
    );
    expect(new Set(Object.values({ ...chat, ...control }).map(base64urlEncode)).size).toBe(5);
  });

  it("binds every address and KDF to the complete server/chat scope", async () => {
    const otherServer = `rcs_${base64urlEncode(bytes(16, 17))}`;
    const otherChat = `rcl_${base64urlEncode(bytes(16, 33))}`;
    expect(await deriveA1ScopeAddress(IDENTITY_ID, otherServer)).not.toBe(
      await deriveA1ScopeAddress(IDENTITY_ID, SERVER_ID),
    );
    expect(await deriveA1ChatAddress(IDENTITY_ID, SERVER_ID, otherChat)).not.toBe(
      await deriveA1ChatAddress(IDENTITY_ID, SERVER_ID, CHAT_ID),
    );
    const original = await vectorKeys();
    const changed = await deriveA1ChatKeys(
      bytes(32, 0x21),
      bytes(32, 0x41),
      bytes(32, 0x61),
      IDENTITY_ID,
      SERVER_ID,
      otherChat,
    );
    expect(changed.contentKey).not.toEqual(original.contentKey);
    expect(changed.controlKey).not.toEqual(original.controlKey);
    expect(changed.metaKey).not.toEqual(original.metaKey);
  });

  it("snapshots mutable key/scope inputs before the first asynchronous boundary", async () => {
    const content = bytes(32, 0x21);
    const control = bytes(32, 0x41);
    const meta = bytes(32, 0x61);
    const identity = IDENTITY_ID.slice();
    const pending = deriveA1ChatKeys(content, control, meta, identity, SERVER_ID, CHAT_ID);
    content.fill(0);
    control.fill(0);
    meta.fill(0);
    identity.fill(0xff);
    expect(await pending).toEqual(await vectorKeys());
  });

  it("rejects noncanonical IDs and wrong key/identity lengths before derivation", async () => {
    await expect(deriveA1ScopeAddress(bytes(15, 0), SERVER_ID)).rejects.toThrow(A1WireError);
    await expect(
      deriveA1ScopeAddress(
        IDENTITY_ID,
        `rcs_${noncanonicalTailAlias(SERVER_ID.slice("rcs_".length))}`,
      ),
    ).rejects.toThrow(/canonical unpadded base64url/);
    await expect(deriveA1ChatAddress(IDENTITY_ID, SERVER_ID, SERVER_ID)).rejects.toThrow(
      /rcl_ namespace/,
    );
    await expect(
      deriveA1ChatKeys(bytes(31, 0), bytes(32, 1), bytes(32, 2), IDENTITY_ID, SERVER_ID, CHAT_ID),
    ).rejects.toThrow(/contentRoot must be exactly 32 bytes/);
  });
});

describe("selected-A1 canonical AAD and message encryption", () => {
  it("locks the byte-exact AAD, stable header, message key, and ciphertext", async () => {
    const header = inboundUserHeader();
    const aad = canonicalA1Aad(header);
    expect(base64urlEncode(aad)).toBe(
      "AAAACAAAAAAAAAACAAAAEAABAgMEBQYHCAkKCwwNDg8AAAAacmNzX0VCRVNFeFFWRmhjWUdSb2JIQjBlSHcBAAAAGnJjbF9JQ0VpSXlRbEppY29LU29yTEMwdUx3AAAAAmluAAAABHVzZXIAAAAADHNvdXJjZS5tc2ctMQAAABpyZGFfTURFeU16UTFOamM0T1RvN1BEMC1QdwEAAAARY2xpZW50OnByb3Bvc2FsLTEAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAIAAAAAAAAAAEAAAAA",
    );
    expect(base64urlEncode(canonicalA1StableLogicalHeader(header))).toBe(
      "AAAACAAAAAAAAAACAAAAEAABAgMEBQYHCAkKCwwNDg8AAAAacmNzX0VCRVNFeFFWRmhjWUdSb2JIQjBlSHcBAAAAGnJjbF9JQ0VpSXlRbEppY29LU29yTEMwdUx3AAAAAmluAAAABHVzZXIAAAAADHNvdXJjZS5tc2ctMQEAAAARY2xpZW50OnByb3Bvc2FsLTEAAAAIAAAAAAAAAAA",
    );
    const keys = await vectorKeys();
    expect(base64urlEncode(await deriveA1MessageKey(keys.contentKey, SALT, aad))).toBe(
      "VgxqNgsTVj3foxiafHp9WtWvSOYgF0UVGA9wienfDaY",
    );
    const sealed = await sealA1FramePartWith(keys.contentKey, header, PLAINTEXT, SALT, NONCE);
    expect(base64urlEncode(sealed.ct)).toBe("ze91G3BHpSxueylTfPPxtA0yDdPzIfPxUKHl30_Pghxeaw");
    const frame = { ...sealed, hostSignature: null } satisfies A1EncryptedFrameV2;
    expect(await openA1FramePart(keys.contentKey, frame)).toEqual(PLAINTEXT);
  });

  it("rejects wrong-plane and AAD transplants at AES-GCM open", async () => {
    const keys = await vectorKeys();
    const sealed = await sealA1FramePartWith(
      keys.contentKey,
      inboundUserHeader(),
      PLAINTEXT,
      SALT,
      NONCE,
    );
    const frame = { ...sealed, hostSignature: null } satisfies A1EncryptedFrameV2;
    await expect(openA1FramePart(keys.controlKey, frame)).rejects.toThrow(
      /AES-GCM authentication failed/,
    );
    await expect(
      openA1FramePart(keys.contentKey, { ...frame, msgId: "source.msg-2" }),
    ).rejects.toThrow(/AES-GCM authentication failed/);
    await expect(
      openA1FramePart(keys.contentKey, {
        ...frame,
        logicalChatId: `rcl_${base64urlEncode(bytes(16, 33))}`,
      }),
    ).rejects.toThrow(/AES-GCM authentication failed/);
  });
});

describe("selected-A1 strict raw JSON codec", () => {
  it("locks the canonical compact frame and round-trips text and raw UTF-8 bytes", async () => {
    const keys = await vectorKeys();
    const sealed = await sealA1FramePartWith(
      keys.contentKey,
      inboundUserHeader(),
      PLAINTEXT,
      SALT,
      NONCE,
    );
    const encoded = encodeA1EncryptedFrameV2({ ...sealed, hostSignature: null });
    expect(encoded).toBe(LOCKED_WIRE);
    expect(encodeA1EncryptedFrameV2Bytes({ ...sealed, hostSignature: null })).toEqual(
      utf8(LOCKED_WIRE),
    );
    expect(encodeA1EncryptedFrameV2(parseA1EncryptedFrameV2(encoded))).toBe(LOCKED_WIRE);
    expect(encodeA1EncryptedFrameV2(parseA1EncryptedFrameV2(utf8(encoded)))).toBe(LOCKED_WIRE);
    expect(await openA1FramePart(keys.contentKey, parseA1EncryptedFrameV2(encoded))).toEqual(
      PLAINTEXT,
    );
  });

  it("accepts insignificant member order/whitespace but emits the canonical order", () => {
    const withoutBraces = LOCKED_WIRE.slice(1, -1);
    const split = withoutBraces.indexOf(",");
    const reordered = `{ ${withoutBraces.slice(split + 1)}, ${withoutBraces.slice(0, split)} }`;
    expect(encodeA1EncryptedFrameV2(parseA1EncryptedFrameV2(reordered))).toBe(LOCKED_WIRE);
  });

  it("rejects duplicate names, including escape aliases, before object construction", () => {
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace('{"v":2', '{"v":2,"v":2'))).toThrow(
      /duplicate JSON member: v/,
    );
    expect(() =>
      parseA1EncryptedFrameV2(LOCKED_WIRE.replace('{"v":2', '{"v":2,"\\u0076":2')),
    ).toThrow(/duplicate JSON member: v/);
    expect(() =>
      parseA1EncryptedFrameV2(
        LOCKED_WIRE.replace('"host_signature":null', '"host_signature":null,"host_signature":null'),
      ),
    ).toThrow(/duplicate JSON member: host_signature/);
  });

  it("rejects unknown, missing, nested, trailing, and wrong-type members", () => {
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace(/}$/, ',"extra":null}'))).toThrow(
      /unknown JSON member: extra/,
    );
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace('"v":2,', ""))).toThrow(
      /missing JSON member: v/,
    );
    expect(() => parseA1EncryptedFrameV2(`${LOCKED_WIRE}x`)).toThrow(/trailing bytes/);
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace(/}$/, ",}"))).toThrow(
      /trailing JSON comma/,
    );
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace('"v":2', '"v":{}'))).toThrow(
      A1WireError,
    );
    expect(() =>
      parseA1EncryptedFrameV2(
        LOCKED_WIRE.replace('"client_msg_id":"client:proposal-1"', '"client_msg_id":null'),
      ),
    ).toThrow(/client_msg_id must be a JSON string/);
  });

  it("rejects every noncanonical outer number spelling before numeric conversion", () => {
    const outbound = encodeA1EncryptedFrameV2(dummyFrame(outboundHeader()));
    const fields = [
      "v",
      "seq",
      "key_epoch",
      "part",
      "parts",
      "server_key_generation",
      "host_signature_sequence",
    ] as const;
    const badTokens = ["-0", "-1", "+1", "01", "1.0", "1e0", "9007199254740992"];
    for (const field of fields) {
      for (const token of badTokens) {
        const changed = outbound.replace(new RegExp(`"${field}":[0-9]+`), `"${field}":${token}`);
        expect(changed, `${field} fixture replacement`).not.toBe(outbound);
        expect(() => parseA1EncryptedFrameV2(changed), `${field}=${token}`).toThrow(A1WireError);
      }
    }
  });

  it("accepts MAX_SAFE_INTEGER but rejects the next integer lexically", () => {
    const max = LOCKED_WIRE.replace('"part":0,"parts":1', '"part":0,"parts":9007199254740991');
    expect(parseA1EncryptedFrameV2(max).parts).toBe(Number.MAX_SAFE_INTEGER);
    const over = max.replace("9007199254740991", "9007199254740992");
    expect(() => parseA1EncryptedFrameV2(over)).toThrow(/must be at most/);
  });

  it("rejects malformed UTF-8 and BOM-prefixed text/bytes before tokenization", () => {
    expect(() => parseA1EncryptedFrameV2(Uint8Array.of(0xc3, 0x28))).toThrow(/well-formed UTF-8/);
    expect(() =>
      parseA1EncryptedFrameV2(concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(LOCKED_WIRE))),
    ).toThrow(/must not begin with a UTF-8 BOM/);
    expect(() => parseA1EncryptedFrameV2(`\ufeff${LOCKED_WIRE}`)).toThrow(
      /must not begin with a UTF-8 BOM/,
    );
  });

  it("rejects padded, aliased, malformed, and wrong-length binary encodings", () => {
    const parsed = parseA1EncryptedFrameV2(LOCKED_WIRE);
    const canonicalCt = base64urlEncode(parsed.ct);
    const alias = noncanonicalTailAlias(canonicalCt);
    expect(base64urlDecode(alias)).toEqual(parsed.ct);
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace(canonicalCt, alias))).toThrow(
      /ct must be canonical unpadded base64url/,
    );
    expect(() =>
      parseA1EncryptedFrameV2(
        LOCKED_WIRE.replace(base64urlEncode(SALT), `${base64urlEncode(SALT)}=`),
      ),
    ).toThrow(/salt must be canonical unpadded base64url/);
    expect(() =>
      parseA1EncryptedFrameV2(
        LOCKED_WIRE.replace(base64urlEncode(NONCE), base64urlEncode(bytes(11, 0xa0))),
      ),
    ).toThrow(/nonce must be canonical unpadded base64url of exactly 12 bytes/);
    expect(() =>
      parseA1EncryptedFrameV2(LOCKED_WIRE.replace(canonicalCt, base64urlEncode(bytes(15, 0)))),
    ).toThrow(/ct must contain at least a 16-byte GCM tag/);
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace(/}$/, ',"tag":"AAAA"}'))).toThrow(
      /unknown JSON member: tag/,
    );

    const outbound = encodeA1EncryptedFrameV2(dummyFrame(outboundHeader()));
    const signature = base64urlEncode(bytes(64, 1));
    expect(() => parseA1EncryptedFrameV2(outbound.replace(signature, `${signature}=`))).toThrow(
      /host_signature must be canonical unpadded base64url/,
    );
    expect(() =>
      parseA1EncryptedFrameV2(outbound.replace(signature, base64urlEncode(bytes(63, 1)))),
    ).toThrow(/host_signature must be canonical unpadded base64url of exactly 64 bytes/);
    expect(() =>
      parseA1EncryptedFrameV2(outbound.replace(signature, noncanonicalTailAlias(signature))),
    ).toThrow(/host_signature must be canonical unpadded base64url/);
  });

  it("requires lowercase identity hex and canonical version/epoch/chunk bounds", () => {
    expect(() =>
      parseA1EncryptedFrameV2(
        LOCKED_WIRE.replace("000102030405060708090a0b0c0d0e0f", "000102030405060708090A0B0C0D0E0F"),
      ),
    ).toThrow(/32 lowercase hexadecimal/);
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace('"v":2', '"v":1'))).toThrow(
      /v must be exactly 2/,
    );
    expect(() =>
      parseA1EncryptedFrameV2(LOCKED_WIRE.replace('"key_epoch":0', '"key_epoch":1')),
    ).toThrow(/keyEpoch must be exactly 0/);
    expect(() => parseA1EncryptedFrameV2(LOCKED_WIRE.replace('"parts":1', '"parts":0'))).toThrow(
      /parts must be at least 1/,
    );
    expect(() =>
      parseA1EncryptedFrameV2(LOCKED_WIRE.replace('"part":0,"parts":1', '"part":1,"parts":1')),
    ).toThrow(/part must be less than parts/);
  });
});

describe("selected-A1 closed header and route rules", () => {
  const contentKinds = [
    "user",
    "assistant",
    "assistant_sub",
    "assistant_thinking",
    "assistant_thinking_sub",
    "result",
    "system",
    "status",
    "rate_limit",
    "can_use_tool",
    "tool_use",
    "tool_result",
    "task",
    "permission_request",
  ] as const;
  const controlKinds = [
    "catch_up",
    "permission",
    "interrupt",
    "set_mode",
    "set_model",
    "command",
    "end",
    "attachment",
  ] as const;
  const metaKinds = [
    "accepted",
    "session_announce",
    "permission_resolved",
    "action_result",
  ] as const;

  it("vectors every closed kind-to-plane mapping and rejects unknown kinds", () => {
    for (const kind of contentKinds) expect(a1PlaneForKind(kind)).toBe("content");
    for (const kind of controlKinds) expect(a1PlaneForKind(kind)).toBe("control");
    for (const kind of metaKinds) expect(a1PlaneForKind(kind)).toBe("meta");
    expect(a1PlaneForKind("new_chat")).toBe("server_control_in");
    expect(a1PlaneForKind("chat_creation_result")).toBe("server_control_out");
    expect(() => a1PlaneForKind("accepted_v2")).toThrow(/unknown record_kind/);
  });

  it("accepts every valid kind family/header combination", () => {
    expect(() => encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader()))).not.toThrow();
    expect(() =>
      encodeA1EncryptedFrameV2(
        dummyFrame(outboundHeader({ recordKind: "user", clientMsgId: "client:proposal-1" })),
      ),
    ).not.toThrow();
    for (const recordKind of contentKinds.filter((kind) => kind !== "user")) {
      expect(() =>
        encodeA1EncryptedFrameV2(dummyFrame(outboundHeader({ recordKind }))),
      ).not.toThrow();
    }
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ recordKind: "attachment" }))),
    ).not.toThrow();
    for (const recordKind of controlKinds.filter((kind) => kind !== "attachment")) {
      expect(() =>
        encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ recordKind, clientMsgId: null }))),
      ).not.toThrow();
    }
    for (const recordKind of metaKinds) {
      expect(() =>
        encodeA1EncryptedFrameV2(dummyFrame(outboundHeader({ recordKind, seq: null }))),
      ).not.toThrow();
    }
    expect(() =>
      encodeA1EncryptedFrameV2(
        dummyFrame(
          inboundUserHeader({ recordKind: "new_chat", logicalChatId: null, part: 0, parts: 1 }),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      encodeA1EncryptedFrameV2(
        dummyFrame(
          outboundHeader({
            recordKind: "chat_creation_result",
            logicalChatId: null,
            clientMsgId: "client:proposal-1",
            part: 0,
            parts: 1,
          }),
        ),
      ),
    ).not.toThrow();
  });

  it("rejects forbidden direction/sequence/client-ID combinations", () => {
    const badHeaders: A1FrameHeaderV2[] = [
      inboundUserHeader({ seq: 0 }),
      inboundUserHeader({ clientMsgId: null }),
      outboundHeader({ recordKind: "user", seq: null }),
      outboundHeader({ recordKind: "assistant", clientMsgId: "client:wrong" }),
      inboundUserHeader({ recordKind: "interrupt", clientMsgId: "client:wrong" }),
      inboundUserHeader({ recordKind: "interrupt", clientMsgId: null, seq: 1 }),
      outboundHeader({ recordKind: "action_result", seq: 1 }),
      outboundHeader({ recordKind: "accepted", dir: "in", seq: null }),
      inboundUserHeader({ recordKind: "new_chat", logicalChatId: null, clientMsgId: null }),
      outboundHeader({
        recordKind: "chat_creation_result",
        logicalChatId: null,
        clientMsgId: null,
      }),
    ];
    for (const header of badHeaders) {
      expect(() => encodeA1EncryptedFrameV2(dummyFrame(header))).toThrow(A1WireError);
    }
  });

  it("requires present message/client/signing IDs to use the bounded safe alphabet", () => {
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ msgId: "contains/slash" }))),
    ).toThrow(/msgId must be 1-128 ASCII bytes/);
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ clientMsgId: "" }))),
    ).toThrow(/clientMsgId must be 1-128 ASCII bytes/);
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ clientMsgId: "é" }))),
    ).toThrow(/clientMsgId must be 1-128 ASCII bytes/);
    expect(() =>
      encodeA1EncryptedFrameV2(
        dummyFrame(outboundHeader({ hostSignerIdentityKeyId: "k".repeat(129) })),
      ),
    ).toThrow(/hostSignerIdentityKeyId must be 1-128 ASCII bytes/);
  });

  it("rejects null-chat/chunk violations and partial host-authentication tuples", () => {
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ logicalChatId: null }))),
    ).toThrow(/non-null logicalChatId/);
    expect(() =>
      encodeA1EncryptedFrameV2(
        dummyFrame(inboundUserHeader({ recordKind: "new_chat", logicalChatId: CHAT_ID })),
      ),
    ).toThrow(/null logicalChatId/);
    expect(() =>
      encodeA1EncryptedFrameV2(
        dummyFrame(inboundUserHeader({ recordKind: "new_chat", logicalChatId: null, parts: 2 })),
      ),
    ).toThrow(/part=0 and parts=1/);
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(inboundUserHeader({ serverKeyGeneration: 1 }))),
    ).toThrow(/inbound host-authentication fields must all be null/);
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(outboundHeader({ hostScopeCertificateId: null }))),
    ).toThrow(/outbound host-authentication fields must all be non-null/);
    expect(() =>
      encodeA1EncryptedFrameV2(dummyFrame(outboundHeader({ serverKeyGeneration: 0 }))),
    ).toThrow(/serverKeyGeneration must be positive/);
    expect(() =>
      encodeA1EncryptedFrameV2({ ...dummyFrame(outboundHeader()), hostSignature: null }),
    ).toThrow(/outbound hostSignature must be non-null/);
    expect(() =>
      encodeA1EncryptedFrameV2({ ...dummyFrame(inboundUserHeader()), hostSignature: bytes(64, 1) }),
    ).toThrow(/inbound hostSignature must be null/);
  });

  it("requires the externally selected route and rejects every transplant class", () => {
    const announce = dummyFrame(outboundHeader({ recordKind: "session_announce", seq: null }));
    const chat = dummyFrame(inboundUserHeader());
    const control = dummyFrame(
      inboundUserHeader({ recordKind: "new_chat", logicalChatId: null, part: 0, parts: 1 }),
    );
    expect(() => assertA1FrameMatchesRoute(announce, route("scope_bus"))).not.toThrow();
    expect(() => assertA1FrameMatchesRoute(chat, chatRoute())).not.toThrow();
    expect(() => assertA1FrameMatchesRoute(control, route("server_control"))).not.toThrow();

    expect(() => assertA1FrameMatchesRoute(chat, route("scope_bus"))).toThrow(/scope_bus/);
    expect(() => assertA1FrameMatchesRoute(announce, chatRoute())).toThrow(/chat route rejects/);
    expect(() => assertA1FrameMatchesRoute(chat, route("server_control"))).toThrow(
      /server_control/,
    );
    expect(() => assertA1FrameMatchesRoute(control, chatRoute())).toThrow(
      /route logical chat mismatch/,
    );
    expect(() => assertA1FrameMatchesRoute(chat, chatRoute({ identityId: bytes(16, 1) }))).toThrow(
      /route identity mismatch/,
    );
    expect(() =>
      assertA1FrameMatchesRoute(
        chat,
        chatRoute({ collaborationServerId: `rcs_${base64urlEncode(bytes(16, 17))}` }),
      ),
    ).toThrow(/route collaboration server mismatch/);
    expect(() =>
      assertA1FrameMatchesRoute(
        chat,
        chatRoute({ logicalChatId: `rcl_${base64urlEncode(bytes(16, 33))}` }),
      ),
    ).toThrow(/route logical chat mismatch/);
  });
});

describe("selected-A1 stable and transport digests", () => {
  it("locks transport, attempt, stable part, and whole-message digests", async () => {
    const keys = await vectorKeys();
    const header = inboundUserHeader();
    const sealed = await sealA1FramePartWith(keys.contentKey, header, PLAINTEXT, SALT, NONCE);
    const frame = { ...sealed, hostSignature: null } satisfies A1EncryptedFrameV2;
    expect(await a1TransportFrameDigest(frame)).toBe("Sa4eEg93WdZPWTtutJzpyPaZ7PMoM5XEjZq4YZAU4Dw");
    expect(await a1AttemptHeaderDigest(header)).toBe("djbkwSz-t5HUO1uA9MbUrpzcsZUE4jYr26sT-QzrwUs");
    expect(await a1AuthenticatedPartDigest(header, PLAINTEXT)).toBe(
      "715Jk-9kSrmE-4IyABLL1rGQ-3qyGUl-b1vFHiix2e4",
    );
    expect(await a1CanonicalMessageDigest(header, PLAINTEXT)).toBe(
      "PsW3ASjq7SUmHa7p1AqZ-9rDySViNHJNKd02ItqMDso",
    );
    expect(base64urlEncode(normalizedA1TransportFrameBytes(frame))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("makes semantic digests stable across fresh transport attempts while transport changes", async () => {
    const keys = await vectorKeys();
    const firstHeader = inboundUserHeader();
    const secondHeader = inboundUserHeader({ deliveryAttemptId: SECOND_ATTEMPT_ID });
    const first = {
      ...(await sealA1FramePartWith(keys.contentKey, firstHeader, PLAINTEXT, SALT, NONCE)),
      hostSignature: null,
    } satisfies A1EncryptedFrameV2;
    const second = {
      ...(await sealA1FramePartWith(
        keys.contentKey,
        secondHeader,
        PLAINTEXT,
        bytes(32, 0xc0),
        bytes(12, 0xe0),
      )),
      hostSignature: null,
    } satisfies A1EncryptedFrameV2;
    expect(await a1TransportFrameDigest(second)).toBe(
      "zpZlZ_Ndl0uv6t1dmV0XJXhL5OrbSVRMBfvOFfw3s4E",
    );
    expect(await a1TransportFrameDigest(first)).not.toBe(await a1TransportFrameDigest(second));
    expect(await a1AttemptHeaderDigest(firstHeader)).toBe(
      await a1AttemptHeaderDigest(secondHeader),
    );
    expect(await a1AuthenticatedPartDigest(firstHeader, PLAINTEXT)).toBe(
      await a1AuthenticatedPartDigest(secondHeader, PLAINTEXT),
    );
    expect(await a1CanonicalMessageDigest(firstHeader, PLAINTEXT)).toBe(
      await a1CanonicalMessageDigest(secondHeader, PLAINTEXT),
    );
  });

  it("changes stable digests for semantic/header/plaintext changes", async () => {
    const header = inboundUserHeader();
    expect(await a1AttemptHeaderDigest(header)).not.toBe(
      await a1AttemptHeaderDigest({ ...header, msgId: "source.msg-2" }),
    );
    expect(await a1AuthenticatedPartDigest(header, PLAINTEXT)).not.toBe(
      await a1AuthenticatedPartDigest(header, utf8("changed")),
    );
    expect(await a1CanonicalMessageDigest(header, PLAINTEXT)).not.toBe(
      await a1CanonicalMessageDigest(header, utf8("changed")),
    );
  });

  it("locks the host-output signature preimage/digest and binds the broker route", async () => {
    const keys = await vectorKeys();
    const sealed = await sealA1FramePartWith(
      keys.contentKey,
      outboundHeader(),
      PLAINTEXT,
      SALT,
      NONCE,
    );
    expect(base64urlEncode(a1HostSignaturePayload(CHAT_ROUTE_ID, sealed))).toBe(
      "AAAAJ3JlbW90ZS1jbGF3L2ExL2hvc3Qtb3V0cHV0LXNpZ25hdHVyZS92MQAAAC9yY3JfcnZyUElFWGVKWi1UUXZrV2dmeVlKZ01sOTlHRldBNF9yZUlWRkZCenNlYwAAAQ0AAAAIAAAAAAAAAAIAAAAQAAECAwQFBgcICQoLDA0ODwAAABpyY3NfRUJFU0V4UVZGaGNZR1JvYkhCMGVIdwEAAAAacmNsX0lDRWlJeVFsSmljb0tTb3JMQzB1THcAAAADb3V0AAAACWFzc2lzdGFudAEAAAAIAAAAAAAAAAcAAAAMc291cmNlLm1zZy0xAAAAGnJkYV9NREV5TXpRMU5qYzRPVG83UEQwLVB3AAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAgAAAAAAAAAAQEAAAAIAAAAAAAAAAMBAAAADGtleS5zZXJ2ZXItMwEAAAAMY2VydC5zY29wZS0zAQAAAAgAAAAAAAAAKQAAACCAgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2enwAAAAygoaKjpKWmp6ipqqsAAAAiw0ieOX-hVcbHsoLF-D53qIGY0vsUSAW-i7TB7OXqeuLVFA",
    );
    expect(await a1HostSignedRecordDigest(CHAT_ROUTE_ID, sealed)).toBe(
      "7wWy678ZjN2qZQoJWM-rlDMTtB0Tk0pmsTVagvfdtT4",
    );
    const otherRoute = await deriveA1BrokerRouteId(
      chatRoute({ logicalChatId: `rcl_${base64urlEncode(bytes(16, 33))}` }),
    );
    expect(await a1HostSignedRecordDigest(otherRoute, sealed)).not.toBe(
      await a1HostSignedRecordDigest(CHAT_ROUTE_ID, sealed),
    );
    expect(() => a1HostSignaturePayload(CHAT_ROUTE_ID, dummyFrame(inboundUserHeader()))).toThrow(
      /inbound frames have no host signature payload/,
    );
  });

  it("includes the signature in transport bytes but excludes it from its own signing preimage", async () => {
    const keys = await vectorKeys();
    const sealed = await sealA1FramePartWith(
      keys.contentKey,
      outboundHeader(),
      PLAINTEXT,
      SALT,
      NONCE,
    );
    const first = { ...sealed, hostSignature: bytes(64, 1) } satisfies A1EncryptedFrameV2;
    const second = { ...sealed, hostSignature: bytes(64, 2) } satisfies A1EncryptedFrameV2;
    expect(a1HostSignaturePayload(CHAT_ROUTE_ID, first)).toEqual(
      a1HostSignaturePayload(CHAT_ROUTE_ID, second),
    );
    expect(await a1TransportFrameDigest(first)).toBe("zx01hDmURFkBpS_2th4Zm5rOOE5iAUSSQmAXFPIZLVc");
    expect(await a1TransportFrameDigest(first)).not.toBe(await a1TransportFrameDigest(second));
  });
});
