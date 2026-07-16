import { describe, expect, it } from "vitest";
import { evaluateLiabilityReconciliation } from "./liability-reconciliation";

describe("evaluateLiabilityReconciliation", () => {
  it("reports ok when the provider balance covers the obligation", () => {
    const result = evaluateLiabilityReconciliation({
      currencyCode: "usd",
      walletLiabilityAmount: "1000.00",
      inFlightPayoutDemandAmount: "250.00",
      providerAvailableAmount: "1250.00",
    });

    expect(result.expectedObligationAmount).toBe("1250.00");
    expect(result.driftAmount).toBe("0.00");
    expect(result.status).toBe("ok");
  });

  it("stays ok when the provider carries surplus float above the obligation", () => {
    const result = evaluateLiabilityReconciliation({
      currencyCode: "usd",
      walletLiabilityAmount: "1000.00",
      inFlightPayoutDemandAmount: "0.00",
      providerAvailableAmount: "5000.00",
    });

    // Surplus is expected platform float, not a shortfall risk.
    expect(result.driftAmount).toBe("4000.00");
    expect(result.status).toBe("ok");
  });

  it("stays ok for a shortfall within the tolerance band", () => {
    const result = evaluateLiabilityReconciliation(
      {
        currencyCode: "usd",
        walletLiabilityAmount: "1000.00",
        inFlightPayoutDemandAmount: "0.00",
        providerAvailableAmount: "999.50",
      },
      "1.00",
    );

    expect(result.driftAmount).toBe("-0.50");
    expect(result.status).toBe("ok");
  });

  it("flags a shortfall-alarm when the obligation exceeds the provider balance beyond tolerance", () => {
    const result = evaluateLiabilityReconciliation(
      {
        currencyCode: "usd",
        walletLiabilityAmount: "1000.00",
        inFlightPayoutDemandAmount: "250.00",
        providerAvailableAmount: "1200.00",
      },
      "1.00",
    );

    // A leak drained the provider balance $50 below what is owed.
    expect(result.expectedObligationAmount).toBe("1250.00");
    expect(result.driftAmount).toBe("-50.00");
    expect(result.status).toBe("shortfall-alarm");
  });
});
