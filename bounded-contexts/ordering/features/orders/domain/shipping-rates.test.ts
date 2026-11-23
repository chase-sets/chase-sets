import { describe, expect, it } from "vitest";
import { OrderingDomainError } from "./common";
import {
  PARCEL_INCLUDED_OUNCES_MAXIMUM,
  PARCEL_INCLUDED_OUNCES_MINIMUM,
  SHIPPING_RATE_MAXIMUM_AMOUNT,
  SHIPPING_RATE_MINIMUM_AMOUNT,
  decodeShippingRates,
  defaultShippingRates,
} from "./shipping-rates";

describe("Shipping Rates", () => {
  it("compiles the six rates buyers are charged today", () => {
    expect(defaultShippingRates).toEqual({
      letterAmount: "1.49",
      standardParcelAmount: "4.99",
      expeditedParcelAmount: "7.49",
      priorityParcelAmount: "9.99",
      parcelIncludedOunces: 4,
      parcelAdditionalOunceAmount: "0.32",
    });
  });

  it("decodes the default unchanged", () => {
    expect(decodeShippingRates(defaultShippingRates)).toEqual(defaultShippingRates);
    expect(decodeShippingRates(JSON.parse(JSON.stringify(defaultShippingRates)))).toEqual(defaultShippingRates);
  });

  it("accepts zero rates and the named bounds", () => {
    const lowest = {
      letterAmount: SHIPPING_RATE_MINIMUM_AMOUNT,
      standardParcelAmount: SHIPPING_RATE_MINIMUM_AMOUNT,
      expeditedParcelAmount: SHIPPING_RATE_MINIMUM_AMOUNT,
      priorityParcelAmount: SHIPPING_RATE_MINIMUM_AMOUNT,
      parcelIncludedOunces: PARCEL_INCLUDED_OUNCES_MINIMUM,
      parcelAdditionalOunceAmount: SHIPPING_RATE_MINIMUM_AMOUNT,
    };
    const highest = {
      letterAmount: SHIPPING_RATE_MAXIMUM_AMOUNT,
      standardParcelAmount: SHIPPING_RATE_MAXIMUM_AMOUNT,
      expeditedParcelAmount: SHIPPING_RATE_MAXIMUM_AMOUNT,
      priorityParcelAmount: SHIPPING_RATE_MAXIMUM_AMOUNT,
      parcelIncludedOunces: PARCEL_INCLUDED_OUNCES_MAXIMUM,
      parcelAdditionalOunceAmount: SHIPPING_RATE_MAXIMUM_AMOUNT,
    };

    expect(lowest).toMatchObject({ letterAmount: "0.00", parcelIncludedOunces: 0 });
    expect(highest).toMatchObject({ letterAmount: "100.00", parcelIncludedOunces: 1000 });
    expect(decodeShippingRates(lowest)).toEqual(lowest);
    expect(decodeShippingRates(highest)).toEqual(highest);
  });

  it.each(Object.keys(defaultShippingRates))("rejects a missing %s", (missingKey) => {
    const withoutKey = Object.fromEntries(Object.entries(defaultShippingRates).filter(([key]) => key !== missingKey));

    expect(Object.keys(withoutKey)).toHaveLength(5);
    expect(() => decodeShippingRates(withoutKey)).toThrow(OrderingDomainError);
  });

  it("rejects an undefined value under a required key", () => {
    expect(() => decodeShippingRates({ ...defaultShippingRates, letterAmount: undefined })).toThrow(
      OrderingDomainError,
    );
  });

  it("rejects an unknown key", () => {
    expect(() => decodeShippingRates({ ...defaultShippingRates, overnightParcelAmount: "19.99" })).toThrow(
      OrderingDomainError,
    );
  });

  it.each([
    ["a numeric amount", { letterAmount: 1.49 }],
    ["a negative amount", { standardParcelAmount: "-4.99" }],
    ["three decimals", { expeditedParcelAmount: "7.490" }],
    ["one decimal", { expeditedParcelAmount: "7.4" }],
    ["no decimals", { priorityParcelAmount: "9" }],
    ["a leading zero", { priorityParcelAmount: "09.99" }],
    ["surrounding whitespace", { letterAmount: " 1.49" }],
    ["an amount above 100.00", { priorityParcelAmount: "100.01" }],
    ["a per-ounce amount above 100.00", { parcelAdditionalOunceAmount: "100.01" }],
    ["a null amount", { parcelAdditionalOunceAmount: null }],
    ["fractional ounces", { parcelIncludedOunces: 4.5 }],
    ["negative ounces", { parcelIncludedOunces: -1 }],
    ["ounces above 1000", { parcelIncludedOunces: 1001 }],
    ["ounces as a string", { parcelIncludedOunces: "4" }],
    ["ounces that are not a number", { parcelIncludedOunces: Number.NaN }],
  ])("rejects %s", (_label, invalidRate) => {
    expect(() => decodeShippingRates({ ...defaultShippingRates, ...invalidRate })).toThrow(OrderingDomainError);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a string", "1.49"],
    ["a number", 149],
  ])("rejects %s in place of the rates", (_label, value) => {
    expect(() => decodeShippingRates(value)).toThrow(OrderingDomainError);
  });
});
