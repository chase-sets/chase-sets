import { describe, expect, it } from "vitest";
import { marketplaceOfferRecoveryCodec } from "./recovery-codec";

describe("Offer lifecycle recovery facts", () => {
  it.each(["paused", "resumed", "withdrawn"])("validates and decodes %s without accepting poisoned facts", (status) => {
    const event = {
      eventType: `marketplace.offer.${status}`,
      payload: { offerId: "off_1", buyerAccountId: "acc_buyer", at: "2026-10-16T00:00:00.000Z" },
    };
    expect(marketplaceOfferRecoveryCodec.decode(event)).toMatchObject({ type: event.eventType, data: event.payload });
    for (const extra of [{ at: "invalid" }, { buyerAccountId: "" }, { offerId: "" }]) {
      expect(() =>
        marketplaceOfferRecoveryCodec.decode({ ...event, payload: { ...event.payload, ...extra } }),
      ).toThrow();
    }
    expect(() => marketplaceOfferRecoveryCodec.decode({ ...event, payload: { offerId: "off_1" } })).toThrow();
    expect(() => marketplaceOfferRecoveryCodec.decode({ ...event, eventType: "marketplace.offer.unknown" })).toThrow();
  });
});
