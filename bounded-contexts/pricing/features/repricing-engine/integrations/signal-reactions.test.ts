import { describe, expect, it, vi } from "vitest";
import type { RepricingEngineServices } from "../api/runtime";
import { buildCompetingAskRepricingReactionHandlers } from "./signal-reactions";

function engineMock() {
  const enqueueCompetingAskSignal = vi.fn(async () => true);
  return {
    enqueueCompetingAskSignal,
    engine: {
      enqueueCompetingAskSignal,
      enqueueMarketPriceSignal: vi.fn(),
      enqueueDailyDriftSweep: vi.fn(),
      previewProductRound: vi.fn(),
      processNextEvaluationJob: vi.fn(),
      projectors: [],
    } as unknown as RepricingEngineServices,
  };
}

function priceEvent(id: string, amount: string, changeSource?: "repricing-engine") {
  return {
    id,
    type: "marketplace.listing.price-updated",
    streamId: "marketplace.listing-lst_dynamic_seller",
    streamVersion: 2,
    data: { priceAmount: amount, ...(changeSource ? { changeSource } : {}) },
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_system", forAccountId: "acc_dynamic_seller" },
    timing: { occurredAt: "2026-07-17T12:00:00.000Z", recordedAt: "2026-07-17T12:00:00.000Z" },
  } as never;
}

describe("repricing competing-ask reactions", () => {
  it("converges the two-seller $100 -> $90 -> $81 -> $72.90 cascade by ignoring engine-originated asks", async () => {
    const { engine, enqueueCompetingAskSignal } = engineMock();
    const handler = buildCompetingAskRepricingReactionHandlers(engine)["marketplace.listing.price-updated"]!;

    await handler(priceEvent("evt_round_1", "90.00", "repricing-engine"));
    await handler(priceEvent("evt_round_2", "81.00", "repricing-engine"));
    await handler(priceEvent("evt_round_3", "72.90", "repricing-engine"));

    expect(enqueueCompetingAskSignal).not.toHaveBeenCalled();
    await handler(priceEvent("evt_manual", "95.00"));
    expect(enqueueCompetingAskSignal).toHaveBeenCalledTimes(1);
  });
});
