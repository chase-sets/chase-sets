import { describe, expect, it } from "vitest";
import { evaluateSellerCheckoutRisk } from "./policy";

describe("seller checkout risk v1 policy", () => {
  it("keeps every fraud, velocity, linkage and manual-review input disabled", () => {
    expect(
      evaluateSellerCheckoutRisk({
        fraud: true,
        velocity: { chargebacks: 99, spend: 999999 },
        sharedInstrumentClusters: 3,
        sharedAddressClusters: 2,
        manualPayoutReview: true,
        payoutHold: true,
      }),
    ).toMatchObject({ status: "clear", reasonCode: null, sourceRevision: 0, rowState: "absent" });
  });
});
