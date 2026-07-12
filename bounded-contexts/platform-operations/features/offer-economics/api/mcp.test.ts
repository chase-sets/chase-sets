import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createOfferEconomicsMcpHandlers } from "./mcp";
import type { OfferEconomicsServices } from "./offer-economics-runtime";

const viewerActor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_admin",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["insights-dashboards.view"],
} satisfies ResolvedActor;

const unauthorizedActor = { ...viewerActor, permissions: [] } satisfies ResolvedActor;

const sampleSnapshot = {
  from: "2026-05-13",
  to: "2026-07-12",
  listingsCreatedCount: 5,
  lockedSellerAccountCount: 1,
  lockedGmvAmount: "300.00",
  lockedTradeCount: 2,
  platformGmvAmount: "6000.00",
  lockedGmvShareRatio: "0.0500",
  standardFeePercentageBps: 900,
  standardFeeFixedAmount: "0.15",
  standardScheduleSource: { scheduleId: "cts_seed_personal_default", scheduleLabel: "Personal Default" },
  foregoneFeeEstimateAmount: "27.30",
  weeklySellThrough: [],
  protectionReserve: { available: false as const, reason: "pending" },
};

function services(): OfferEconomicsServices {
  return {
    crossContextAvailable: true,
    getOfferEconomicsSnapshot: vi.fn(async () => sampleSnapshot),
  };
}

describe("offer-economics MCP handlers (#4075)", () => {
  it("returns the offer-economics summary for a viewer actor via the tool", async () => {
    const fakeServices = services();
    const handlers = createOfferEconomicsMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["platform-operations.get-offer-economics-summary"]!({
      actor: viewerActor,
      arguments: {},
    } as never);

    expect(result).toEqual({ snapshot: sampleSnapshot });
  });

  it("returns the same summary via the resource URI", async () => {
    const fakeServices = services();
    const handlers = createOfferEconomicsMcpHandlers(fakeServices);

    const result = await handlers.resourceHandlers["chase-sets://platform-operations/offer-economics/summary"]!({
      actor: viewerActor,
      uri: "chase-sets://platform-operations/offer-economics/summary",
    } as never);

    expect(result).toEqual({ snapshot: sampleSnapshot });
  });

  it("rejects an actor without insights-dashboards.view", async () => {
    const fakeServices = services();
    const handlers = createOfferEconomicsMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["platform-operations.get-offer-economics-summary"]!({
        actor: unauthorizedActor,
        arguments: {},
      } as never),
    ).rejects.toThrow("insights-dashboards.view is required");
    expect(fakeServices.getOfferEconomicsSnapshot).not.toHaveBeenCalled();
  });
});
