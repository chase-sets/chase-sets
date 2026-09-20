import { describe, expect, it, vi } from "vitest";
import {
  channelsServicesMembers,
  isChannelsServices,
  type ChannelsServices,
} from "../support/runtime-support/services";

describe("channels-services-guard-negative", () => {
  it.each([
    "readChannelDriftDetail",
    "readChannelDriftDecision",
    "acceptChannelDrift",
    "repushChannelListing",
  ] as const)("rejects missing detail consumer method %s", (method) => {
    const candidate = validCandidate();
    const reconciliation = Object.fromEntries(
      Object.entries(candidate.reconciliation).filter(([key]) => key !== method),
    );
    expect(isChannelsServices({ ...candidate, reconciliation })).toBe(false);
  });
  it("accepts the complete aggregate candidate", () => {
    expect(isChannelsServices(validCandidate())).toBe(true);
  });

  it.each([null, undefined, false, 0, "channels", []])("rejects non-aggregate input %s", (candidate) => {
    expect(isChannelsServices(candidate)).toBe(false);
  });

  it.each(channelsServicesMembers)("rejects missing or invalid %s", (member) => {
    const candidate = validCandidate();
    expect(isChannelsServices(candidate)).toBe(true);
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
    expect(isChannelsServices(candidate)).toBe(true);
    expect(isChannelsServices({ ...candidate, connections: {} })).toBe(false);
    expect(isChannelsServices({ ...candidate, storageLocationAuthority: {} })).toBe(false);
    expect(isChannelsServices({ ...candidate, reconciliation: {} })).toBe(false);
    expect(isChannelsServices({ ...candidate, reconciliation: { reconcileDueConnections: vi.fn() } })).toBe(false);
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

  it.each(["submitObservation", "readConnectionHealth", "listOpenReasonGenerations"] as const)(
    "rejects an omitted or invalid health %s without losing manual sync",
    (member) => {
      const candidate = validCandidate();
      expect(isChannelsServices(candidate)).toBe(true);
      const missing = Object.fromEntries(Object.entries(candidate.connectionHealth).filter(([key]) => key !== member));
      expect(isChannelsServices({ ...candidate, connectionHealth: missing })).toBe(false);
      expect(
        isChannelsServices({ ...candidate, connectionHealth: { ...candidate.connectionHealth, [member]: null } }),
      ).toBe(false);
    },
  );
});

function validCandidate() {
  return {
    connections: { getConnection: async () => null },
    storageLocationAuthority: { resolve: async () => null },
    connectionHealth: { submitObservation: vi.fn(), readConnectionHealth: vi.fn(), listOpenReasonGenerations: vi.fn() },
    connectionAttention: { listOpenAttention: vi.fn(), resolveAttention: vi.fn() },
    listingComposition: {},
    outboundSync: {
      recoverExpiredClaimedOperations: async () => 0,
      processNextInlineOperation: async () => 0,
    },
    reconciliation: {
      reconcileDueConnections: async () => [],
      deliverHealthObservations: vi.fn(),
      readChannelDriftDetail: vi.fn(),
      readChannelDriftDecision: vi.fn(),
      acceptChannelDrift: vi.fn(),
      repushChannelListing: vi.fn(),
    },
    tcgplayerCsv: {},
    manualSync: {},
    projectors: [],
    db: {},
  } satisfies Record<keyof ChannelsServices, unknown>;
}
