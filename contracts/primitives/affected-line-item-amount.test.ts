import { describe, expect, it } from "vitest";
import { normalizeAffectedLineItemAmount, normalizeAffectedLineItemAmounts } from "./affected-line-item-amount";

describe("affected line-item amount primitive", () => {
  it("normalizes canonical decimal strings and currency codes", () => {
    expect(normalizeAffectedLineItemAmount({ lineId: " line_1 ", amount: "10.5", currencyCode: " USD " })).toEqual({
      lineId: "line_1",
      amount: "10.50",
      currencyCode: "usd",
    });
  });

  it.each([
    { lineId: "", amount: "1.00", currencyCode: "usd" },
    { lineId: "line_1", amount: "1.005", currencyCode: "usd" },
    { lineId: "line_1", amount: "1.00", currencyCode: "us" },
  ])("rejects malformed affected line facts", (input) => {
    expect(() => normalizeAffectedLineItemAmount(input)).toThrow();
  });

  it("rejects duplicate line ids", () => {
    expect(() =>
      normalizeAffectedLineItemAmounts([
        { lineId: "line_1", amount: "1.00", currencyCode: "usd" },
        { lineId: "line_1", amount: "2.00", currencyCode: "usd" },
      ]),
    ).toThrow("is duplicated");
  });
});
