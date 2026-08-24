import { describe, expect, expectTypeOf, it } from "vitest";
import * as cli from "../index.js";
import * as broker from "./index.js";

describe("@remote-claw/cli/broker barrel (browser-safe surface)", () => {
  it("re-exports the transport, orderer, plane mapping, and provider", () => {
    expect(typeof broker.BrokerClient).toBe("function");
    expect(typeof broker.FrameOrderer).toBe("function");
    expect(typeof broker.securityProvider).toBe("function");
    expect(typeof broker.planeForKind).toBe("function");
    expect(typeof broker.BrokerError).toBe("function");
    expect(typeof broker.BrokerPermanentStorageLossError).toBe("function");
    expect(broker.BrokerPermanentStorageLossError).toBe(cli.BrokerPermanentStorageLossError);
    expectTypeOf(broker.BrokerPermanentStorageLossError).toEqualTypeOf(
      cli.BrokerPermanentStorageLossError,
    );
    expect(typeof broker.BrokerStreamRotationError).toBe("function");
    expect(broker.CONTENT_KINDS.has("assistant")).toBe(true);
    expect(broker.CONTENT_KINDS.has("permission_resolved")).toBe(false);
    expect(broker.CONTROL_KINDS.has("interrupt")).toBe(true);
    expect(broker.META_KINDS.has("session_announce")).toBe(true);
    expect(broker.META_KINDS.has("session_terminal")).toBe(true);
    expect(broker.META_KINDS.has("permission_resolved")).toBe(true);
  });
});
