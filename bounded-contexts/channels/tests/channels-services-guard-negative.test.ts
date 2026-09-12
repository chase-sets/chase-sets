import { describe, expect, it } from "vitest";
import { channelsServicesMembers, isChannelsServices } from "../support/runtime-support/services";

describe("channels-services-guard-negative", () => {
  it.each([null, undefined, false, 0, "channels", []])("rejects non-aggregate input %s", (candidate) => {
    expect(isChannelsServices(candidate)).toBe(false);
  });

  it.each(channelsServicesMembers)("rejects missing or invalid %s", (member) => {
    const candidate = validCandidate();
    const missing = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== member));
    expect(isChannelsServices(missing)).toBe(false);
    expect(isChannelsServices({ ...candidate, [member]: null })).toBe(false);
    expect(isChannelsServices({ ...candidate, [member]: "invalid" })).toBe(false);
  });

  it("rejects partial aggregate candidates", () => {
    expect(
      isChannelsServices({
        outboundSync: {
          recoverExpiredClaimedOperations: async () => 0,
          processNextInlineOperation: async () => 0,
        },
      }),
    ).toBe(false);
    expect(isChannelsServices({ connections: { getConnection: async () => null } })).toBe(false);
  });

  it("rejects every omitted consumer method", () => {
    const candidate = validCandidate();
    expect(isChannelsServices({ ...candidate, connections: {} })).toBe(false);
    expect(
      isChannelsServices({
        ...candidate,
        outboundSync: { processNextInlineOperation: async () => 0 },
      }),
    ).toBe(false);
    expect(
      isChannelsServices({
        ...candidate,
        outboundSync: { recoverExpiredClaimedOperations: async () => 0 },
      }),
    ).toBe(false);
  });
});

function validCandidate() {
  return {
    connections: { getConnection: async () => null },
    listingComposition: {},
    outboundSync: {
      recoverExpiredClaimedOperations: async () => 0,
      processNextInlineOperation: async () => 0,
    },
    tcgplayerCsv: {},
    manualSync: {},
    projectors: [],
    db: {},
  };
}
