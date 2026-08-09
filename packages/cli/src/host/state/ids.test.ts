import { base64urlEncode } from "@remote-claw/clawsec";
import { describe, expect, it } from "vitest";
import {
  A1_CANONICAL_ID_SPECS,
  HostStateContractError,
  isA1CanonicalId,
  isA1SafeId,
  parseA1CanonicalId,
  parseA1Digest,
  parseA1SafeId,
  parseDispatchAuthorization,
  parseEd25519PublicKey,
  parseEd25519Signature,
  parseMachineIdentityId,
  parseWardenLaunchNonce,
} from "./ids.js";

function encoded(bytes: number, fill = 0): string {
  return base64urlEncode(new Uint8Array(bytes).fill(fill));
}

describe("selected A1 identifier contracts", () => {
  it("keeps the exported namespace specifications deeply immutable", () => {
    expect(Object.isFrozen(A1_CANONICAL_ID_SPECS)).toBe(true);
    expect(Object.isFrozen(A1_CANONICAL_ID_SPECS.collaborationServer)).toBe(true);
    expect(Reflect.set(A1_CANONICAL_ID_SPECS.collaborationServer, "bodyBytes", 0)).toBe(false);
    expect(() => parseA1CanonicalId("collaborationServer", "rcs_")).toThrow(/exactly 16 bytes/);
  });

  it("accepts the exact registered namespaces and canonical body sizes", () => {
    for (const [kind, spec] of Object.entries(A1_CANONICAL_ID_SPECS)) {
      const value = `${spec.prefix}${encoded(spec.bodyBytes, spec.bodyBytes)}`;
      expect(parseA1CanonicalId(kind as keyof typeof A1_CANONICAL_ID_SPECS, value)).toBe(value);
      expect(isA1CanonicalId(kind as keyof typeof A1_CANONICAL_ID_SPECS, value)).toBe(true);
    }
  });

  it("keeps durable A1 native bindings out of the process-local rcb_ namespace", () => {
    expect(A1_CANONICAL_ID_SPECS.nativeBinding.prefix).toBe("rcnb_");
    expect(() =>
      parseA1CanonicalId("nativeBinding", `rcb_${encoded(16)}`, "nativeBindingId"),
    ).toThrow(/rcnb_/);
  });

  it("reserves a canonical random namespace for inward collaboration edges", () => {
    expect(A1_CANONICAL_ID_SPECS.inwardEdge).toEqual({
      prefix: "rcie_",
      bodyBytes: 16,
      allocation: "random",
    });
    expect(() => parseA1CanonicalId("inwardEdge", "inward-edge-1", "inwardEdgeId")).toThrow(
      /rcie_/,
    );
  });

  it("keeps native runtime scopes in their own derived namespace", () => {
    expect(A1_CANONICAL_ID_SPECS.nativeRuntime).toEqual({
      prefix: "rcrt_",
      bodyBytes: 32,
      allocation: "derived_sha256",
    });
    expect(() => parseA1CanonicalId("nativeRuntime", `rcnb_${encoded(16)}`, "runtimeId")).toThrow(
      /rcrt_/,
    );
  });

  it("rejects wrong prefixes, byte lengths, padding, and noncanonical trailing bits", () => {
    expect(() => parseA1CanonicalId("collaborationServer", `rcl_${encoded(16)}`)).toThrow(
      HostStateContractError,
    );
    expect(() => parseA1CanonicalId("collaborationServer", `rcs_${encoded(15)}`)).toThrow(
      /exactly 16 bytes/,
    );
    expect(() => parseA1CanonicalId("collaborationServer", `rcs_${encoded(16)}=`)).toThrow(
      /matching/,
    );

    const canonical = encoded(16);
    const noncanonical = `${canonical.slice(0, -1)}B`;
    expect(noncanonical).not.toBe(canonical);
    expect(() => parseA1CanonicalId("collaborationServer", `rcs_${noncanonical}`)).toThrow(
      /canonical/,
    );
  });

  it("enforces the shared safe-ID grammar and 128-byte limit without normalization", () => {
    expect(parseA1SafeId("A-z_09.:")).toBe("A-z_09.:");
    expect(isA1SafeId("a".repeat(128))).toBe(true);
    expect(isA1SafeId("a".repeat(129))).toBe(false);
    for (const value of ["", "has space", "slash/value", "é", 'quote"']) {
      expect(isA1SafeId(value)).toBe(false);
    }
  });

  it("accepts only canonical 32-byte digests and one-use authorizations", () => {
    const value = encoded(32, 7);
    expect(parseA1Digest(value)).toBe(value);
    expect(parseDispatchAuthorization(value)).toBe(value);
    expect(() => parseA1Digest(encoded(31))).toThrow(/exactly 32 bytes/);
    expect(() => parseDispatchAuthorization(`${value}=`)).toThrow(/canonical/);
    expect(() => parseA1Digest("A".repeat(1_000_000))).toThrow(/exactly 32 bytes/);
    expect(() => parseDispatchAuthorization("A".repeat(1_000_000))).toThrow(/exactly 32 bytes/);
  });

  it("keeps runtime nonce and Ed25519 byte roles nominal and exact", () => {
    const bytes32 = encoded(32, 8);
    const bytes64 = encoded(64, 9);
    expect(parseWardenLaunchNonce(bytes32)).toBe(bytes32);
    expect(parseEd25519PublicKey(bytes32)).toBe(bytes32);
    expect(parseEd25519Signature(bytes64)).toBe(bytes64);
    expect(() => parseWardenLaunchNonce(encoded(31))).toThrow(/exactly 32 bytes/);
    expect(() => parseEd25519PublicKey(encoded(33))).toThrow(/exactly 32 bytes/);
    expect(() => parseEd25519Signature(encoded(32))).toThrow(/exactly 64 bytes/);
    expect(() => parseEd25519Signature(`${bytes64}=`)).toThrow(/canonical|matching/);
  });

  it("accepts only the fixed lowercase machine identity encoding", () => {
    expect(parseMachineIdentityId("01".repeat(16))).toBe("01".repeat(16));
    expect(() => parseMachineIdentityId("AB".repeat(16))).toThrow(/lowercase/);
    expect(() => parseMachineIdentityId("0".repeat(31))).toThrow(/exactly 32/);
  });

  it("never includes a rejected secret or identifier in the error", () => {
    const secret = `sensitive-${"x".repeat(140)}`;
    let error: unknown;
    try {
      parseDispatchAuthorization(secret, "dispatchAuthorization");
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain("dispatchAuthorization");
  });
});
