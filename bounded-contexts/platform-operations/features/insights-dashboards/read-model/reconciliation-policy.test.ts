import { describe, expect, it } from "vitest";
import { computeGmvReconciliation, GMV_RECONCILIATION_DRIFT_BAND } from "./reconciliation-policy";

describe("computeGmvReconciliation", () => {
  it("is 'ok' when the ledger sits comfortably below gross tape GMV (expected: net of fee)", () => {
    const result = computeGmvReconciliation({ tapeGmvAmount: "1000.00", ledgerSaleAmount: "950.00" });
    expect(result.status).toBe("ok");
    expect(result.deltaAmount).toBe("50.00");
    expect(result.deltaRatio).toBe("0.0500");
  });

  it("is 'ok' at exact equality (zero drift)", () => {
    const result = computeGmvReconciliation({ tapeGmvAmount: "1000.00", ledgerSaleAmount: "1000.00" });
    expect(result.status).toBe("ok");
    expect(result.deltaAmount).toBe("0.00");
  });

  it("is 'drift-alarm' when the ledger total EXCEEDS gross tape GMV (impossible for a net-of-fee subset)", () => {
    const result = computeGmvReconciliation({ tapeGmvAmount: "1000.00", ledgerSaleAmount: "1000.01" });
    expect(result.status).toBe("drift-alarm");
  });

  it("is 'drift-alarm' when the undershoot exceeds the documented band", () => {
    const overBand = (GMV_RECONCILIATION_DRIFT_BAND.maxUndershootRatio + 0.01) * 1000;
    const result = computeGmvReconciliation({
      tapeGmvAmount: "1000.00",
      ledgerSaleAmount: (1000 - overBand).toFixed(2),
    });
    expect(result.status).toBe("drift-alarm");
  });

  it("is 'ok' right at the documented undershoot boundary", () => {
    const atBand = GMV_RECONCILIATION_DRIFT_BAND.maxUndershootRatio * 1000;
    const result = computeGmvReconciliation({
      tapeGmvAmount: "1000.00",
      ledgerSaleAmount: (1000 - atBand).toFixed(2),
    });
    expect(result.status).toBe("ok");
  });

  it("treats a zero-GMV month with a zero ledger as 'ok', not a divide-by-zero drift alarm", () => {
    const result = computeGmvReconciliation({ tapeGmvAmount: "0.00", ledgerSaleAmount: "0.00" });
    expect(result.status).toBe("ok");
    expect(result.deltaRatio).toBeNull();
  });

  it("flags a zero-GMV month with a nonzero ledger as drift (an impossible population mismatch)", () => {
    const result = computeGmvReconciliation({ tapeGmvAmount: "0.00", ledgerSaleAmount: "10.00" });
    expect(result.status).toBe("drift-alarm");
  });
});
