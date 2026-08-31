import { describe, expect, it } from "vitest";
import {
  BrokerOriginError,
  normalizeBrokerOrigin,
  protectionBypassForBrokerOrigin,
} from "./origin.js";

describe("broker app origin", () => {
  it.each([
    ["https://Broker.Example", "https://broker.example"],
    ["HTTPS://broker.example", "https://broker.example"],
    ["https://localhost.", "https://localhost"],
    ["https://broker.example/", "https://broker.example"],
    ["https://broker.example:443", "https://broker.example"],
    ["https://broker.example:8443/", "https://broker.example:8443"],
    ["http://localhost:3100/", "http://localhost:3100"],
    ["http://127.0.0.1:3100", "http://127.0.0.1:3100"],
    ["http://[::1]:3100/", "http://[::1]:3100"],
  ])("canonicalizes %s", (raw, expected) => {
    expect(normalizeBrokerOrigin(raw)).toBe(expected);
  });

  it.each([
    "",
    " broker.example",
    "https://broker.example ",
    "https:\\broker.example",
    "//broker.example",
    "ftp://broker.example",
    "http://broker.example",
    "http://localhost.example",
    "https://user@broker.example",
    "https://broker.example/api",
    "https://broker.example/?backend=sqlite",
    "https://broker.example/#pass",
    "https://broker.example/.",
  ])("rejects non-origin target %s", (raw) => {
    expect(() => normalizeBrokerOrigin(raw)).toThrow(BrokerOriginError);
  });

  it("keeps an ambient bypass inert on loopback or without an RC_APP pin", () => {
    for (const origin of [
      "http://127.0.0.1:3100",
      "https://localhost.",
      "https://foo.localhost",
      "https://127.0.1.2",
      "https://[::ffff:127.0.0.1]",
    ]) {
      expect(
        protectionBypassForBrokerOrigin(origin, {
          RC_APP: origin,
          VERCEL_AUTOMATION_BYPASS_SECRET: "do-not-send",
        }),
      ).toBeUndefined();
    }
    expect(
      protectionBypassForBrokerOrigin("https://broker.example", {
        VERCEL_AUTOMATION_BYPASS_SECRET: "",
      }),
    ).toBeUndefined();
    expect(() =>
      protectionBypassForBrokerOrigin("https://broker.example", {
        VERCEL_AUTOMATION_BYPASS_SECRET: "do-not-send",
      }),
    ).toThrow(/RC_APP must pin/);
  });

  it("returns the bypass only for the canonical RC_APP pin", () => {
    expect(
      protectionBypassForBrokerOrigin("https://broker.example/", {
        RC_APP: "https://BROKER.example:443",
        VERCEL_AUTOMATION_BYPASS_SECRET: "scoped-secret",
      }),
    ).toBe("scoped-secret");
  });

  it("fails closed on a mismatched pin without echoing either target or secret", () => {
    const target = "https://attacker.invalid";
    const secret = "never-echo-this-secret";
    let message = "";
    try {
      protectionBypassForBrokerOrigin(target, {
        RC_APP: "https://broker.example",
        VERCEL_AUTOMATION_BYPASS_SECRET: secret,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/does not match/);
    expect(message).not.toContain(target);
    expect(message).not.toContain(secret);
  });
});
