import { describe, expect, it } from "vitest";
import { effectiveSaleAmount, effectiveSaleAmountExact } from "../domain/effective-sale-price";

describe("TCGplayer source-exact effective sale price and Chase money adaptation", () => {
  it.each([1, 2, 6, 10])("keeps 5.39 with zero shipping at quantity %i", (quantity) => {
    expect(effectiveSaleAmountExact({ quantity, unitPrice: 5.39, orderShipping: 0 }, 5)).toBe(5.39);
  });

  it("ports the four pinned source families", () => {
    expect(effectiveSaleAmountExact({ quantity: 2, unitPrice: 5.39, orderShipping: 1 }, 5)).toBe(5.89);
    expect(effectiveSaleAmountExact({ quantity: 0, unitPrice: 5.39, orderShipping: 1 }, 5)).toBe(6.39);
    expect(effectiveSaleAmountExact({ quantity: 10, unitPrice: 4.99, orderShipping: 1 }, 5)).toBe(4.99);
  });

  it("allocates first and rounds half-up once at the Chase boundary", () => {
    const input = { quantity: 3, unitPrice: 5.39, orderShipping: 1 };
    expect(effectiveSaleAmountExact(input, 5)).toBe(5.723333333333333);
    expect(effectiveSaleAmount(input, 5)).toBe("5.72");
  });
});
