import { describe, expect, it } from "vitest";
import { phaseFor } from "./relay.js";

// The worker_status → presence "phase" mapping that drives the viewer's thinking indicator (#48).
// The integration spine can't reliably catch the sub-millisecond busy→idle window, so pin the mapping
// here deterministically. "running" is what live claude (2.1.x) reports; "busy" is the older/captured
// protocol value — both mean actively generating.
describe("phaseFor", () => {
  it("maps actively-generating statuses to 'thinking'", () => {
    expect(phaseFor("running")).toBe("thinking");
    expect(phaseFor("busy")).toBe("thinking");
  });

  it("maps everything else to 'idle' (not actively generating)", () => {
    for (const s of ["idle", "requires_action", "WORKER_STATUS_UNSPECIFIED", "", "weird"]) {
      expect(phaseFor(s)).toBe("idle");
    }
  });
});
