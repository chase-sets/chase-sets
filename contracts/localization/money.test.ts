import { describe, expect, it } from "vitest";
import { formatMoney } from "./money";

describe("formatMoney", () => {
  it("formats a canonical USD amount with a leading symbol", () => {
    expect(formatMoney("145.00", "USD")).toBe("$145.00");
  });

  it("uppercases lower-cased currency codes", () => {
    expect(formatMoney("12.34", "usd")).toBe("$12.34");
  });

  it("pads single-decimal amounts to two fraction digits", () => {
    expect(formatMoney("12.3", "USD")).toBe("$12.30");
  });

  it("pads whole-number amounts to two fraction digits", () => {
    expect(formatMoney("12", "USD")).toBe("$12.00");
  });

  it("groups thousands", () => {
    expect(formatMoney("1234567.89", "USD")).toBe("$1,234,567.89");
  });

  it("formats negative amounts with the sign before the currency symbol", () => {
    expect(formatMoney("-42.50", "USD")).toBe("-$42.50");
  });

  it("formats a zero amount", () => {
    expect(formatMoney("0.00", "USD")).toBe("$0.00");
  });

  it("does not lose precision for large amounts near the money ceiling", () => {
    expect(formatMoney("9999999999.99", "USD")).toBe("$9,999,999,999.99");
  });

  it("falls back to a raw amount-plus-currency-code string for unparsable input", () => {
    expect(formatMoney("pending", "USD")).toBe("pending USD");
  });

  it("renders identically for the same value across every call site format", () => {
    const walletValue = formatMoney("145.00", "usd");
    const cartValue = formatMoney("145.00", "USD");

    expect(walletValue).toBe(cartValue);
    expect(walletValue).toBe("$145.00");
  });
});
