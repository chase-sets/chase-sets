import { describe, expect, it } from "vitest";
import { isChannelsServices } from "../server";

describe("channels-services-guard-negative", () => {
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
    projectors: [],
    db: {},
  };
}
