import { describe, expect, it } from "vitest";
import { tryMoneyToCents } from "@chase-sets/primitives/money";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as platformOperationsModule } from "../../../index";
import contextManifest from "../../../context.json" with { type: "json" };
import {
  CAPTURE_ANOMALY_ORDER,
  REFUND_ANOMALY_ORDER,
  admitSaleMoney,
  canonicalCents,
  classifyCaptureAtomicAnomalies,
  deriveCaptureAnomalies,
  extractClassificationInputs,
  isAdmittedCurrency,
  selectAffectedRefundFact,
  type CaptureFact,
  type OrderMoneyFact,
  type RefundFact,
} from "./projection";
import {
  addUtcMonths,
  isCursorAdvanced,
  isLookbackAnchorEligible,
  isWithinHalfOpenWindow,
  MAX_PAGE_LIMIT,
} from "./queries";
import { sellerComplianceSalesSchemaMigrations, sellerComplianceSalesSchemaStatements } from "./schema";

// Unmistakably synthetic identities throughout: no fixture here is paired with a real
// account, order, or payment.
const SELLER = "acct_synthetic_seller_1";
const OTHER_SELLER = "acct_synthetic_seller_2";

function validPayout(orderId: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    orderId,
    sellerAccountId: SELLER,
    marketplaceSalesFeeAmount: "10.00",
    sellerItemNetAmount: "90.00",
    shippingAllowanceAmount: "5.00",
    sellerShippingPayoutAmount: "5.00",
    protectionAmount: "0.00",
    protectionAllowanceAmount: "0.00",
    protectionOverageAmount: "0.00",
    sellerPayoutAmount: "95.00",
    ...overrides,
  };
}

function capture(overrides: Partial<CaptureFact> = {}): CaptureFact {
  return {
    paymentId: "pay_synthetic_1",
    orderIds: ["ord_synthetic_1"],
    sellerPayouts: [validPayout("ord_synthetic_1")],
    currencyCode: "usd",
    capturedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

const validOrderMoney: OrderMoneyFact = {
  itemSubtotalAmount: "100.00",
  shippingChargeAmount: "5.00",
  shippingAllowanceAmount: "5.00",
  salesTaxAmount: "8.00",
  authenticityFeeAmount: "0.00",
  protectionAmount: "0.00",
  protectionAllowanceAmount: "0.00",
  protectionOverageAmount: "0.00",
  orderTotalAmount: "113.00",
};

function refund(overrides: Partial<RefundFact> = {}): RefundFact {
  return {
    paymentId: "pay_synthetic_1",
    orderIds: ["ord_synthetic_1"],
    refundedOrderAmounts: [{ orderId: "ord_synthetic_1", amount: "40.00" }],
    orderRefundCaps: [{ orderId: "ord_synthetic_1", amount: "113.00" }],
    currencyCode: "usd",
    refundedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function failingPool(): PgTransactionalPool {
  const fail = () => {
    throw new Error("Registration wiring must not query the database.");
  };
  return { query: fail, connect: fail } as never;
}

describe("seller compliance capture payout law", () => {
  it("classifies every combined payout anomaly deterministically", () => {
    const payouts = [
      validPayout("ord_synthetic_A"),
      validPayout("ord_synthetic_A"),
      validPayout("ord_synthetic_C", { sellerItemNetAmount: "12.3" }),
      validPayout("ord_synthetic_Z"),
      validPayout("ord_synthetic_A", { protectionAmount: undefined }),
    ];
    const combined = capture({
      orderIds: ["ord_synthetic_A", "ord_synthetic_A", "ord_synthetic_B", "ord_synthetic_C"],
      sellerPayouts: payouts,
      currencyCode: "USD",
    });

    const atomic = classifyCaptureAtomicAnomalies(combined);
    const complete = deriveCaptureAnomalies(atomic, SELLER, OTHER_SELLER, []);

    expect(complete).toEqual([...CAPTURE_ANOMALY_ORDER]);
    expect(complete).toHaveLength(8);
    expect(new Set(complete).size).toBe(complete.length);

    // Payout input order cannot change a capture-atomic verdict.
    const shuffled = classifyCaptureAtomicAnomalies({ ...combined, sellerPayouts: [...payouts].reverse() });
    expect(shuffled).toEqual(atomic);
    // Replaying the same event reproduces the same set rather than accumulating reasons.
    expect(classifyCaptureAtomicAnomalies(combined)).toEqual(atomic);
  });

  it.each([
    ["duplicate-capture-order-id", capture({ orderIds: ["ord_synthetic_1", "ord_synthetic_1"] })],
    [
      "extra-payout-component",
      capture({ sellerPayouts: [validPayout("ord_synthetic_1"), validPayout("ord_synthetic_extra")] }),
    ],
    [
      "duplicate-payout-component",
      capture({ sellerPayouts: [validPayout("ord_synthetic_1"), validPayout("ord_synthetic_1")] }),
    ],
    ["missing-payout-component", capture({ orderIds: ["ord_synthetic_1", "ord_synthetic_2"] })],
    ["currency-invalid", capture({ currencyCode: "USD" })],
    [
      "canonical-money-invalid",
      capture({ sellerPayouts: [validPayout("ord_synthetic_1", { sellerPayoutAmount: "12.3" })] }),
    ],
    ["source-field-missing", capture({ capturedAt: undefined })],
  ])("isolates %s with no other reason", (reason, isolated) => {
    expect(classifyCaptureAtomicAnomalies(isolated)).toEqual([reason]);
  });

  it("adds seller-mismatch only once Ordering's authoritative seller exists", () => {
    const atomic = classifyCaptureAtomicAnomalies(capture());
    expect(atomic).toEqual([]);
    expect(deriveCaptureAnomalies(atomic, null, OTHER_SELLER, [])).toEqual([]);
    expect(deriveCaptureAnomalies(atomic, SELLER, SELLER, [])).toEqual([]);
    expect(deriveCaptureAnomalies(atomic, SELLER, OTHER_SELLER, [])).toEqual(["seller-mismatch"]);
  });
});

describe("seller compliance money admission", () => {
  it("admits only usd canonical bounded money", () => {
    expect(isAdmittedCurrency("usd")).toBe(true);
    expect(isAdmittedCurrency("USD")).toBe(false);
    expect(isAdmittedCurrency("")).toBe(false);
    expect(isAdmittedCurrency(undefined)).toBe(false);

    expect(canonicalCents("0.00")).toBe(0n);
    expect(canonicalCents("113.00")).toBe(11300n);
    expect(canonicalCents("9999999999.99")).toBe(999999999999n);

    for (const rejected of ["12.3", " 1.00 ", "01.00", "1,000.00", "-1.00", "1.000", "", "10000000000.00", "1"]) {
      expect(canonicalCents(rejected), rejected).toBeNull();
    }
    // Never coerced: a non-string is rejected outright rather than stringified to zero.
    expect(canonicalCents(100)).toBeNull();
    expect(canonicalCents(null)).toBeNull();
    expect(canonicalCents(undefined)).toBeNull();

    // The permissive parser would have accepted the first discriminating invalid values,
    // which is exactly why it is not the admission predicate.
    expect(tryMoneyToCents("12.3")).toBe(1230n);
    expect(tryMoneyToCents(" 1.00 ")).toBe(100n);
    expect(tryMoneyToCents("01.00")).toBe(100n);
  });

  it("populates every money column only when both sides are complete and reconcile", () => {
    const admitted = admitSaleMoney(validOrderMoney, validPayout("ord_synthetic_1"), "usd");
    expect(admitted.orderSideAnomalies).toEqual([]);
    expect(admitted.mismatches).toEqual([]);
    expect(admitted.money).toEqual({
      itemGrossCents: 10000n,
      shippingChargeCents: 500n,
      salesTaxCents: 800n,
      authenticityFeeCents: 0n,
      protectionCents: 0n,
      protectionAllowanceCents: 0n,
      protectionOverageCents: 0n,
      orderTotalCents: 11300n,
      marketplaceSalesFeeCents: 1000n,
      sellerItemNetCents: 9000n,
      shippingAllowanceCents: 500n,
      sellerShippingPayoutCents: 500n,
      sellerPayoutCents: 9500n,
    });
  });

  it("fails closed on every cross-source disagreement without inferring zero", () => {
    const split = admitSaleMoney(
      validOrderMoney,
      validPayout("ord_synthetic_1", { sellerItemNetAmount: "80.00" }),
      "usd",
    );
    expect(split.mismatches).toEqual(["item-gross-vs-payout-split"]);
    expect(split.money).toBeNull();

    const shipping = admitSaleMoney(
      { ...validOrderMoney, shippingAllowanceAmount: "6.00" },
      validPayout("ord_synthetic_1"),
      "usd",
    );
    expect(shipping.mismatches).toEqual(["shipping-allowance-representation"]);
    expect(shipping.money).toBeNull();

    const protection = admitSaleMoney(
      { ...validOrderMoney, protectionAmount: "1.00", protectionAllowanceAmount: "1.00" },
      validPayout("ord_synthetic_1"),
      "usd",
    );
    expect(protection.mismatches).toEqual(["protection-representation", "protection-allowance-representation"]);
    expect(protection.money).toBeNull();

    const wrongCurrency = admitSaleMoney(validOrderMoney, validPayout("ord_synthetic_1"), "USD");
    expect(wrongCurrency.money).toBeNull();

    const absentOrderValue = admitSaleMoney(
      { ...validOrderMoney, salesTaxAmount: null },
      validPayout("ord_synthetic_1"),
      "usd",
    );
    expect(absentOrderValue.orderSideAnomalies).toEqual(["source-field-missing"]);
    expect(absentOrderValue.money).toBeNull();

    const invalidOrderValue = admitSaleMoney(
      { ...validOrderMoney, salesTaxAmount: "8.3" },
      validPayout("ord_synthetic_1"),
      "usd",
    );
    expect(invalidOrderValue.orderSideAnomalies).toEqual(["canonical-money-invalid"]);
    expect(invalidOrderValue.money).toBeNull();

    // An order fact that has not arrived is not an anomaly; it is simply not yet complete.
    expect(admitSaleMoney(null, validPayout("ord_synthetic_1"), "usd").money).toBeNull();
    expect(admitSaleMoney(null, validPayout("ord_synthetic_1"), "usd").orderSideAnomalies).toEqual([]);
  });
});

describe("seller compliance affected-order refund membership", () => {
  const twoOrderPayment = ["ord_synthetic_1", "ord_synthetic_2"];

  it("binds exactly one affected order to payment-scoped cumulative entries", () => {
    const paymentWide = refund({
      orderIds: ["ord_synthetic_1"],
      refundedOrderAmounts: [
        { orderId: "ord_synthetic_2", amount: "7.00" },
        { orderId: "ord_synthetic_1", amount: "40.00" },
      ],
      orderRefundCaps: [
        { orderId: "ord_synthetic_1", amount: "113.00" },
        { orderId: "ord_synthetic_2", amount: "50.00" },
      ],
    });

    const affected = selectAffectedRefundFact(paymentWide, "ord_synthetic_1", twoOrderPayment);
    expect(affected).toEqual({
      anomalies: [],
      refundedOrderTotalCents: 4000n,
      orderRefundCapCents: 11300n,
    });

    // Shuffled entry order and redelivery assign, never accumulate.
    const shuffled = selectAffectedRefundFact(
      {
        ...paymentWide,
        refundedOrderAmounts: [...(paymentWide.refundedOrderAmounts as unknown[])].reverse(),
        orderRefundCaps: [...(paymentWide.orderRefundCaps as unknown[])].reverse(),
      },
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(shuffled).toEqual(affected);
    expect(selectAffectedRefundFact(paymentWide, "ord_synthetic_1", twoOrderPayment)).toEqual(affected);

    // Full-refund equality is decidable from the affected order's own two values.
    const fullyRefunded = selectAffectedRefundFact(
      refund({ refundedOrderAmounts: [{ orderId: "ord_synthetic_1", amount: "113.00" }] }),
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(fullyRefunded.refundedOrderTotalCents).toBe(fullyRefunded.orderRefundCapCents);
  });

  it("ignores entries for payment orders outside the affected set", () => {
    const paymentWide = refund({
      orderIds: ["ord_synthetic_1"],
      refundedOrderAmounts: [
        { orderId: "ord_synthetic_1", amount: "40.00" },
        { orderId: "ord_synthetic_2", amount: "7.00" },
      ],
      orderRefundCaps: [
        { orderId: "ord_synthetic_1", amount: "113.00" },
        { orderId: "ord_synthetic_2", amount: "50.00" },
      ],
    });
    // The unaffected order's entries raise nothing: they are expected producer output.
    expect(selectAffectedRefundFact(paymentWide, "ord_synthetic_1", twoOrderPayment).anomalies).toEqual([]);
  });

  it("fails closed on a duplicate or missing entry that an unaffected order cannot cure", () => {
    const duplicated = selectAffectedRefundFact(
      refund({
        refundedOrderAmounts: [
          { orderId: "ord_synthetic_1", amount: "40.00" },
          { orderId: "ord_synthetic_1", amount: "40.00" },
        ],
      }),
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(duplicated.anomalies).toEqual(["duplicate-refunded-amount-entry"]);
    expect(duplicated.refundedOrderTotalCents).toBeNull();
    expect(duplicated.orderRefundCapCents).toBeNull();

    // Only the *unaffected* order has an amount entry; the affected one is missing and the
    // present sibling entry cannot substitute for it.
    const missing = selectAffectedRefundFact(
      refund({ refundedOrderAmounts: [{ orderId: "ord_synthetic_2", amount: "7.00" }] }),
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(missing.anomalies).toEqual(["missing-refunded-amount-entry"]);
    expect(missing.refundedOrderTotalCents).toBeNull();

    const missingCap = selectAffectedRefundFact(
      refund({ orderRefundCaps: [{ orderId: "ord_synthetic_2", amount: "50.00" }] }),
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(missingCap.anomalies).toEqual(["missing-refund-cap-entry"]);
    expect(missingCap.orderRefundCapCents).toBeNull();

    const duplicateCap = selectAffectedRefundFact(
      refund({
        orderRefundCaps: [
          { orderId: "ord_synthetic_1", amount: "113.00" },
          { orderId: "ord_synthetic_1", amount: "113.00" },
        ],
      }),
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(duplicateCap.anomalies).toEqual(["duplicate-refund-cap-entry"]);

    const notAMember = selectAffectedRefundFact(refund({ orderIds: ["ord_synthetic_9"] }), "ord_synthetic_9", [
      "ord_synthetic_1",
    ]);
    expect(notAMember.anomalies).toContain("refund-order-membership-invalid");
    expect(notAMember.refundedOrderTotalCents).toBeNull();

    // Membership is not asserted before a capture has been observed for the payment.
    expect(selectAffectedRefundFact(refund(), "ord_synthetic_1", null).anomalies).toEqual([]);
  });

  it("keeps the refund anomaly set sorted, duplicate-free, and total", () => {
    const combined = selectAffectedRefundFact(
      refund({
        orderIds: ["ord_synthetic_1", "ord_synthetic_1"],
        refundedOrderAmounts: [
          { orderId: "ord_synthetic_1", amount: "40.00" },
          { orderId: "ord_synthetic_1", amount: "40.00" },
        ],
        orderRefundCaps: [],
        currencyCode: "USD",
        refundedAt: undefined,
      }),
      "ord_synthetic_1",
      ["ord_synthetic_2"],
    );
    expect(combined.anomalies).toEqual([
      "duplicate-refund-order-id",
      "refund-order-membership-invalid",
      "duplicate-refunded-amount-entry",
      "missing-refund-cap-entry",
      "currency-invalid",
      "source-field-missing",
    ]);
    expect(combined.anomalies.every((reason) => REFUND_ANOMALY_ORDER.includes(reason))).toBe(true);

    const nonCanonical = selectAffectedRefundFact(
      refund({ refundedOrderAmounts: [{ orderId: "ord_synthetic_1", amount: "40.3" }] }),
      "ord_synthetic_1",
      twoOrderPayment,
    );
    expect(nonCanonical.anomalies).toEqual(["canonical-money-invalid"]);
    expect(nonCanonical.refundedOrderTotalCents).toBeNull();
  });
});

describe("seller compliance classification inputs", () => {
  it("records the approved matrix inputs and no identifying line detail", () => {
    const inputs = extractClassificationInputs([
      {
        lineId: "line-1",
        catalogItemId: "cat-1",
        productId: "prd-1",
        itemTitle: "Synthetic Title",
        itemSubtitle: "Synthetic Subtitle",
        productSummary: "Synthetic Summary",
        selectedOptions: [{ dimensionId: "printing", optionId: "holofoil", extra: "ignored" }],
        quantity: 2,
        lineTotalAmount: "100.00",
        gradedCard: { gradingCompany: "PSA", grade: "10", certificationNumber: "9999999" },
      },
    ]);

    expect(inputs).toEqual([
      {
        lineId: "line-1",
        catalogItemId: "cat-1",
        productId: "prd-1",
        selectedOptions: [{ dimensionId: "printing", optionId: "holofoil" }],
        quantity: 2,
        lineTotalAmount: "100.00",
        gradedCard: { gradingCompany: "PSA", grade: "10" },
      },
    ]);
    const serialized = JSON.stringify(inputs);
    for (const excluded of ["certificationNumber", "9999999", "Synthetic Title", "Synthetic Summary"]) {
      expect(serialized).not.toContain(excluded);
    }
  });
});

describe("seller compliance half-open time contract", () => {
  it("keeps one half-open millisecond convention and an inclusive lookback floor", () => {
    const window = { fromInclusive: "2026-01-01T00:00:00.000Z", toExclusive: "2026-04-01T00:00:00.000Z" };
    expect(isWithinHalfOpenWindow("2025-12-31T23:59:59.999Z", window)).toBe(false);
    expect(isWithinHalfOpenWindow("2026-01-01T00:00:00.000Z", window)).toBe(true);
    expect(isWithinHalfOpenWindow("2026-03-31T23:59:59.999Z", window)).toBe(true);
    expect(isWithinHalfOpenWindow("2026-04-01T00:00:00.000Z", window)).toBe(false);

    // Calendar-month arithmetic clamps to the target month's last day.
    expect(addUtcMonths("2026-01-31T12:00:00.000Z", 1)).toBe("2026-02-28T12:00:00.000Z");
    expect(addUtcMonths("2024-01-31T12:00:00.000Z", 1)).toBe("2024-02-29T12:00:00.000Z");
    expect(addUtcMonths("2026-01-01T00:00:00.000Z", 12)).toBe("2027-01-01T00:00:00.000Z");

    // The floor is inclusive: eligible at exactly the nominal instant, expired at +1 ms.
    const anchor = "2026-01-01T00:00:00.000Z";
    expect(isLookbackAnchorEligible(anchor, 12, "2027-01-01T00:00:00.000Z")).toBe(true);
    expect(isLookbackAnchorEligible(anchor, 12, "2027-01-01T00:00:00.001Z")).toBe(false);
    expect(isLookbackAnchorEligible(anchor, 12, "2026-12-31T23:59:59.999Z")).toBe(true);
  });

  it("rejects a cursor that would not advance", () => {
    expect(isCursorAdvanced("seller-1", "seller-2")).toBe(true);
    expect(isCursorAdvanced("seller-1", null)).toBe(true);
    expect(isCursorAdvanced("seller-1", "seller-1")).toBe(false);
    expect(
      isCursorAdvanced(
        { occurredAt: "a", paymentId: "b", orderId: "c" },
        { occurredAt: "a", paymentId: "b", orderId: "c" },
      ),
    ).toBe(false);
    expect(MAX_PAGE_LIMIT).toBe(100);
  });
});

describe("seller compliance production registration", () => {
  it("registers two source subscriptions covering four events", () => {
    const services = platformOperationsModule.createServices(failingPool(), {});
    const subscriptions = (platformOperationsModule.buildSubscriptions?.(services) ?? []).filter(
      (subscription) => subscription.projectionName === "seller-compliance-sales-projection",
    );

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map((subscription) => subscription.sourceContextName).sort()).toEqual([
      "ordering",
      "payments",
    ]);
    expect(subscriptions.every((subscription) => subscription.handlerKind === "projection")).toBe(true);

    const handlerEventTypes = subscriptions.flatMap((subscription) => Object.keys(subscription.handlers));
    expect(handlerEventTypes.sort()).toEqual([
      "ordering.order.cancelled",
      "ordering.order.created",
      "payments.payment-captured",
      "payments.payment-refunded",
    ]);
    // Exactly once each: `(sourceContextName, projectionName)` keying must not duplicate a
    // registration or split one projection across two handler sets.
    expect(new Set(handlerEventTypes).size).toBe(handlerEventTypes.length);

    const declaredEventTypes = subscriptions.flatMap((subscription) => [...(subscription.eventTypes ?? [])]);
    expect(declaredEventTypes.sort()).toEqual(handlerEventTypes.sort());

    // A fact recorder reacts to nothing.
    const reactions = (platformOperationsModule.buildSubscriptions?.(services) ?? []).filter(
      (subscription) =>
        subscription.handlerKind !== "projection" &&
        subscription.projectionName === "seller-compliance-sales-projection",
    );
    expect(reactions).toEqual([]);
  });

  it("registers the production handler and re-derives every moved inventory", () => {
    const services = platformOperationsModule.createServices(failingPool(), {});
    const subscriptions = platformOperationsModule.buildSubscriptions?.(services) ?? [];
    const registered = subscriptions.filter(
      (subscription) => subscription.projectionName === "seller-compliance-sales-projection",
    );

    // The handlers are reached only through the one manifest-built registration.
    expect(registered).toHaveLength(2);
    for (const subscription of registered) {
      expect(subscription.subscriptionName).toBe("platform-operations.seller-compliance-sales-projection");
      expect(subscription.subscriptionVersion).toBe(1);
    }

    const group = (contextManifest as { projectionGroups: readonly Record<string, unknown>[] }).projectionGroups.find(
      (entry) => entry.projectionName === "seller-compliance-sales-projection",
    );
    expect(group).toMatchObject({
      sourceContextNames: ["ordering", "payments"],
      ownedTables: ["platform_operations_seller_compliance_order_facts", "platform_operations_seller_compliance_sales"],
      requiredDuringBootstrap: true,
      resetStrategy: "replay-only",
    });

    // Boot schema and the ledgered migration are composed from one ordered statement array,
    // so a boot-only or migration-only object cannot exist.
    expect(sellerComplianceSalesSchemaMigrations).toHaveLength(1);
    expect(sellerComplianceSalesSchemaMigrations[0]!.statements).toEqual(sellerComplianceSalesSchemaStatements);
    expect(platformOperationsModule.schemaMigrations).toEqual(
      expect.arrayContaining([...sellerComplianceSalesSchemaMigrations]),
    );
    for (const statement of sellerComplianceSalesSchemaStatements) {
      expect(platformOperationsModule.schemaSql).toContain(statement);
    }

    // No worker, scheduled runner, checkpoint table, or policy surface belongs to this slice.
    expect(platformOperationsModule.schemaSql).not.toContain("seller_compliance_sweep_checkpoints");
  });
});
