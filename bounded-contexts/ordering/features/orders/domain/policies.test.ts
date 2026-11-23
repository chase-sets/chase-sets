import { describe, expect, it } from "vitest";
import type { PackagePlan, PackagePlanPackage } from "@chase-sets/product-measures";
import { OrderingDomainError, type ShippingOption } from "./common";
import {
  calculateOrderFulfillmentEconomics,
  defaultShippingQuotePolicy,
  quoteMarketplaceSalesFeeFromSnapshot,
  resolveOrderPaymentDeadline,
  resolveTerminalPaymentFailureDeadline,
} from "./policies";
import { defaultShippingRates, type ShippingRates } from "./shipping-rates";

const letter = (): PackagePlanPackage => ({
  packageId: "pkg_letter",
  mailpieceClass: "letter",
  lengthInches: 6,
  widthInches: 4,
  heightInches: 0.1,
  weightOunces: 0.46,
  billableWeightOunces: 0.46,
  serviceLevel: "letter",
  productMeasureVersions: ["pmv_1"],
});

const parcel = (billableWeightOunces: number): PackagePlanPackage => ({
  packageId: `pkg_parcel_${billableWeightOunces}`,
  mailpieceClass: "parcel",
  lengthInches: 7,
  widthInches: 5,
  heightInches: 1,
  weightOunces: billableWeightOunces,
  billableWeightOunces,
  serviceLevel: "standard-parcel",
  productMeasureVersions: ["pmv_1"],
});

const planOf = (...packages: PackagePlanPackage[]): PackagePlan => ({
  packagePlanVersion: "test-package-plan-v1",
  packageCount: packages.length,
  packages,
  letterEligibility: { eligible: false, reasons: ["test-plan"] },
  missingProductIds: [],
});

const quoteShipping = (
  packagePlan: PackagePlan,
  shippingRates: ShippingRates,
  shippingOption: ShippingOption = "standard",
  itemSubtotalAmount = "20.00",
) =>
  defaultShippingQuotePolicy.quote({
    sellerAccountId: "acc_seller",
    shippingOption,
    itemSubtotalAmount,
    quantity: 1,
    listingCount: 1,
    packagePlan,
    shippingRates,
  });

const zeroShippingRates: ShippingRates = {
  letterAmount: "0.00",
  standardParcelAmount: "0.00",
  expeditedParcelAmount: "0.00",
  priorityParcelAmount: "0.00",
  parcelIncludedOunces: 0,
  parcelAdditionalOunceAmount: "0.00",
};

describe("shipping quote subtotal validation", () => {
  it.each(["abc", "10000000000.00"])(
    "keeps subtotal validation after removing the unused binding: %s",
    (itemSubtotalAmount) => {
      expect(() => quoteShipping(planOf(parcel(4)), defaultShippingRates, "standard", itemSubtotalAmount)).toThrow(
        "Item subtotal must be a valid decimal.",
      );
    },
  );

  it("keeps zero-subtotal shipping arithmetic unchanged", () => {
    const packagePlan = planOf(parcel(4));

    expect(quoteShipping(packagePlan, defaultShippingRates, "standard", "0.00")).toEqual({
      shippingOption: "standard",
      baseAmount: "4.99",
      discountAmount: "0.00",
      chargeAmount: "4.99",
      packagePlan,
    });
  });
});

describe("shipping quote under the default Shipping Rates", () => {
  it.each([
    ["a letter", "standard", letter(), "1.49"],
    ["a 4 ounce standard parcel", "standard", parcel(4), "4.99"],
    ["a 4 ounce expedited parcel", "expedited", parcel(4), "7.49"],
    ["a 4 ounce priority parcel", "priority", parcel(4), "9.99"],
    ["a 6 ounce standard parcel", "standard", parcel(6), "5.63"],
    ["a 1 ounce standard parcel", "standard", parcel(1), "4.99"],
    ["a 5 ounce priority parcel", "priority", parcel(5), "10.31"],
  ] as const)("quotes %s", (_label, shippingOption, pkg, amount) => {
    const packagePlan = planOf(pkg);

    expect(quoteShipping(packagePlan, defaultShippingRates, shippingOption)).toEqual({
      shippingOption,
      baseAmount: amount,
      discountAmount: "0.00",
      chargeAmount: amount,
      packagePlan,
    });
  });

  it("sums every package of a multi-package plan in whole cents", () => {
    // 149 + (499 + 2 x 32) + (499 + 16 x 32) + (499 + 3 x 32) cents.
    expect(quoteShipping(planOf(letter(), parcel(6), parcel(20), parcel(7)), defaultShippingRates).baseAmount).toBe(
      "23.18",
    );
  });
});

describe("shipping quote under the Shipping Rates it is given", () => {
  const otherShippingRates: ShippingRates = {
    letterAmount: "2.00",
    standardParcelAmount: "6.00",
    expeditedParcelAmount: "8.25",
    priorityParcelAmount: "12.00",
    parcelIncludedOunces: 8,
    parcelAdditionalOunceAmount: "0.50",
  };

  it.each([
    ["a letter", "standard", letter(), "2.00"],
    ["an 8 ounce standard parcel", "standard", parcel(8), "6.00"],
    ["a 10 ounce standard parcel", "standard", parcel(10), "7.00"],
    ["a 10 ounce expedited parcel", "expedited", parcel(10), "9.25"],
    ["a 10 ounce priority parcel", "priority", parcel(10), "13.00"],
  ] as const)("charges other rates for %s", (_label, shippingOption, pkg, amount) => {
    expect(quoteShipping(planOf(pkg), otherShippingRates, shippingOption).baseAmount).toBe(amount);
  });

  it.each([
    ["letter", { letterAmount: "0.00" }, "10.11"],
    ["standard parcel", { standardParcelAmount: "0.00" }, "6.61"],
    ["additional ounce", { parcelAdditionalOunceAmount: "0.00" }, "6.48"],
  ] as const)("adds nothing for a zero %s rate", (_label, zeroRate, amount) => {
    // The default rates quote 149 + (499 + 16 x 32) cents for this plan.
    const packagePlan = planOf(letter(), parcel(20));

    expect(quoteShipping(packagePlan, defaultShippingRates).baseAmount).toBe("11.60");
    expect(quoteShipping(packagePlan, { ...defaultShippingRates, ...zeroRate }).baseAmount).toBe(amount);
  });

  it("charges every billable ounce when no ounces are included", () => {
    expect(quoteShipping(planOf(parcel(3)), { ...defaultShippingRates, parcelIncludedOunces: 0 }).baseAmount).toBe(
      "5.95",
    );
  });

  it("quotes 0.00 for a plan when every rate is zero", () => {
    const packagePlan = planOf(letter(), parcel(20));

    expect(quoteShipping(packagePlan, zeroShippingRates, "priority")).toEqual({
      shippingOption: "priority",
      baseAmount: "0.00",
      discountAmount: "0.00",
      chargeAmount: "0.00",
      packagePlan,
    });
  });

  it.each(["standard", "expedited", "priority"] as const)(
    "refuses a plan with no packages under %s shipping instead of answering from a per-order table",
    (shippingOption) => {
      expect(() => quoteShipping(planOf(), defaultShippingRates, shippingOption)).toThrow(OrderingDomainError);
      expect(() => quoteShipping(planOf(), zeroShippingRates, shippingOption)).toThrow(
        "A shipping quote requires a package plan with at least one package.",
      );
    },
  );
});

describe("ordering Order Protection economics (#4098)", () => {
  it.each([
    ["10.00", "0.10", "0.40", "4.10", "4.10", "13.50"],
    ["50.00", "0.50", "2.00", "2.50", "2.50", "49.50"],
    ["125.00", "1.25", "4.50", "0.00", "0.00", "117.50"],
    ["500.00", "5.00", "4.50", "0.00", "0.00", "470.00"],
  ])(
    "documents the $%s buyer Shipping line, seller payout, and reserve split byte-exactly",
    (itemSubtotal, protection, shippingAllowance, shippingOverage, buyerShipping, sellerPayout) => {
      const economics = calculateOrderFulfillmentEconomics({
        itemSubtotalAmount: itemSubtotal,
        shippingBaseAmount: "4.50",
        shippingAllowancePercentageBps: 500,
      });
      const fee = quoteMarketplaceSalesFeeFromSnapshot(itemSubtotal, {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
      });
      const payoutCents =
        BigInt(fee.sellerNetUnitAmount.replace(".", "")) +
        BigInt(economics.sellerShippingPayoutAmount.replace(".", "")) -
        BigInt(economics.protectionAllowanceAmount.replace(".", ""));

      expect(economics).toEqual({
        shippingBaseAmount: "4.50",
        shippingDiscountAmount: shippingAllowance,
        shippingAllowanceAmount: shippingAllowance,
        shippingOverageAmount: shippingOverage,
        sellerShippingPayoutAmount: shippingOverage,
        protectionAmount: protection,
        protectionAllowanceAmount: protection,
        protectionOverageAmount: "0.00",
        shippingChargeAmount: buyerShipping,
      });
      expect(`${payoutCents / 100n}.${String(payoutCents % 100n).padStart(2, "0")}`).toBe(sellerPayout);
    },
  );

  it("funds protection before shipping and rounds up to keep every positive order covered", () => {
    expect(
      calculateOrderFulfillmentEconomics({
        itemSubtotalAmount: "0.01",
        shippingBaseAmount: "0.00",
        shippingAllowancePercentageBps: 0,
      }),
    ).toMatchObject({
      protectionAmount: "0.01",
      protectionAllowanceAmount: "0.00",
      protectionOverageAmount: "0.01",
      shippingChargeAmount: "0.01",
    });
  });
});

describe("ordering marketplace sales fee snapshots", () => {
  it.each([
    ["10.00", "0.50", "9.50"],
    ["400.00", "20.00", "380.00"],
    ["600.00", "25.00", "575.00"],
    ["1000.00", "25.00", "975.00"],
  ])("recomputes $%s from the byte-exact locked formula", (unitPriceAmount, fee, sellerNet) => {
    expect(
      quoteMarketplaceSalesFeeFromSnapshot(unitPriceAmount, {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
      }),
    ).toEqual({ marketplaceSalesFeeUnitAmount: fee, sellerNetUnitAmount: sellerNet });
  });
});

describe("ordering payment deadline policies", () => {
  it.each([
    ["card", "2026-03-31T01:00:00.000Z", "ordering-payment-deadline-card-v1"],
    ["bank-account", "2026-04-05T00:00:00.000Z", "ordering-payment-deadline-bank-account-v1"],
    ["platform-credit", "2026-03-31T00:15:00.000Z", "ordering-payment-deadline-platform-credit-v1"],
  ] as const)(
    "resolves %s deadlines through policy tokens",
    (methodCategory, paymentDeadlineAt, paymentDeadlinePolicy) => {
      expect(resolveOrderPaymentDeadline("2026-03-31T00:00:00.000Z", methodCategory)).toEqual({
        paymentDeadlineAt,
        paymentDeadlinePolicy,
      });
    },
  );

  it("uses the terminal-failure grace token for failed payment windows", () => {
    expect(resolveTerminalPaymentFailureDeadline("2026-03-31T00:00:00.000Z")).toEqual({
      paymentDeadlineAt: "2026-03-31T00:05:00.000Z",
      paymentDeadlinePolicy: "ordering-payment-deadline-terminal-failure-grace-v1",
    });
  });
});
