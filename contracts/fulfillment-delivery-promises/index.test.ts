import { describe, expect, it } from "vitest";
import { createFulfillmentDeliveryPromise } from "./index";

const baseInput = {
  shippingOption: "standard",
  packageCount: 1,
  serviceLevels: ["standard-parcel"],
  shipFrom: { city: "Chicago", state: "IL", country: "US" },
  shipTo: { city: "Madison", state: "WI", country: "US" },
};

describe("fulfillment delivery promise policy", () => {
  it("keeps same-day packing for domestic checkout before seller cutoff", () => {
    const promise = createFulfillmentDeliveryPromise({
      ...baseInput,
      now: "2026-06-01T15:00:00.000Z",
    });

    expect(promise).toMatchObject({
      promiseOwner: "fulfillment",
      promiseSource: "fulfillment-promise-policy",
      promiseConfidence: "estimated",
      packingStartDate: "2026-06-01",
      carrierHandoffDate: "2026-06-02",
      earliestDate: "2026-06-08",
      latestDate: "2026-06-11",
      minimumTransitDays: 4,
      maximumTransitDays: 7,
      handlingDays: 1,
    });
    expect(promise.basis).toContain("domestic");
    expect(promise.basis).toContain("before cutoff");
  });

  it("moves packing to the next business day after cutoff or weekend", () => {
    const afterCutoff = createFulfillmentDeliveryPromise({
      ...baseInput,
      now: "2026-06-05T17:00:00.000Z",
    });
    const weekend = createFulfillmentDeliveryPromise({
      ...baseInput,
      now: "2026-06-06T10:00:00.000Z",
    });

    expect(afterCutoff.packingStartDate).toBe("2026-06-08");
    expect(afterCutoff.carrierHandoffDate).toBe("2026-06-09");
    expect(weekend.packingStartDate).toBe("2026-06-08");
    expect(weekend.basis).toContain("after cutoff/weekend handoff");
  });

  it("extends remote-region delivery windows", () => {
    const promise = createFulfillmentDeliveryPromise({
      ...baseInput,
      shipTo: { city: "Honolulu", state: "HI", country: "US" },
      now: "2026-06-01T15:00:00.000Z",
    });

    expect(promise.minimumTransitDays).toBe(6);
    expect(promise.maximumTransitDays).toBe(11);
    expect(promise.basis).toContain("remote-region");
  });

  it("adds handling time for multi-package seller groups", () => {
    const promise = createFulfillmentDeliveryPromise({
      ...baseInput,
      packageCount: 3,
      serviceLevels: ["standard-parcel", "priority-signature"],
      now: "2026-06-01T15:00:00.000Z",
    });

    expect(promise.packageCount).toBe(3);
    expect(promise.handlingDays).toBe(2);
    expect(promise.carrierHandoffDate).toBe("2026-06-03");
    expect(promise.serviceLevel).toBe("standard parcel, priority signature");
  });
});
