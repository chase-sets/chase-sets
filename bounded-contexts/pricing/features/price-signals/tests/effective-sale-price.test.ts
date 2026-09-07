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

  it("rounds exact half-cent allocations up", () => {
    expect(effectiveSaleAmount({ quantity: 2, unitPrice: 5, orderShipping: 0.03 }, 5)).toBe("5.02");
  });

  it("matches integer-rational half-up across a bounded exhaustive cent domain", () => {
    for (let unitCents = 490; unitCents <= 510; unitCents += 1) {
      for (let shippingCents = 0; shippingCents <= 99; shippingCents += 1) {
        for (let quantity = 1; quantity <= 10; quantity += 1) {
          const numerator = BigInt(unitCents * quantity + (unitCents >= 500 ? shippingCents : 0));
          const divisor = BigInt(quantity);
          const expectedCents = (numerator * 2n + divisor) / (divisor * 2n);
          const expected = `${expectedCents / 100n}.${(expectedCents % 100n).toString().padStart(2, "0")}`;
          expect(
            effectiveSaleAmount(
              { quantity, unitPrice: unitCents / 100, orderShipping: shippingCents / 100 },
              5,
            ),
          ).toBe(expected);
        }
      }
    }
  });

  it("keeps the round-total-before-allocation mutant red", () => {
    const input = { quantity: 3, unitPrice: 5.39, orderShipping: 1 };
    const mutant = (((539 + 100) / 3) / 100).toFixed(2);
    expect(mutant).not.toBe(effectiveSaleAmount(input, 5));
  });
});
