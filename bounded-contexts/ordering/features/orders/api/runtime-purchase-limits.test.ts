import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { TaxQuoteResolver } from "./runtime";
import type { AuthenticityFeePolicyResolver } from "./authenticity-fee-policy-resolver";
import { defaultAuthenticityCheckFeePolicyValue } from "../domain/authenticity-check-fee";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  createSupplyDb,
  shippingAddress,
} from "./runtime-test-harness";

describe("checkout purchase-limit admission", () => {
  it.each(["tax", "authenticity", "order ids"])(
    "checkout-preclaim-failure-does-not-consume-limit: %s",
    async (failure) => {
      const db = createSupplyDb(() => [
        {
          listingId: "lst_1",
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Card",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: null,
          shipFromCode: "CHI",
          priceAmount: "150.00",
          availableQuantity: 5,
          maxUnitsPerDay: 2,
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ]);
      const { eventStore, readAllEvents } = createInMemoryEventStore();
      const quoteTax = vi
        .fn<TaxQuoteResolver["quoteTax"]>(async () => {
          throw new Error("tax unavailable");
        })
        .mockResolvedValueOnce({
          taxableAmount: "150.00",
          taxAmount: "0.00",
          jurisdictionCountry: "US",
          jurisdictionState: "IL",
          rateBps: 0,
          itemTaxable: true,
          shippingTaxable: false,
          marketplaceCheckoutFeeTaxable: false,
          providerName: "test-tax",
          providerQuoteReference: null,
          quotedAt: "2026-09-01T00:00:00.000Z",
        });
      const resolveAuthenticityFeePolicy = vi
        .fn<AuthenticityFeePolicyResolver["resolveAuthenticityFeePolicy"]>(async () => {
          throw new Error("authenticity unavailable");
        })
        .mockResolvedValueOnce({
          value: defaultAuthenticityCheckFeePolicyValue,
          source: "fallback",
          documentId: null,
          effectiveFrom: null,
          resolvedAt: "2026-09-01T00:00:00.000Z",
        });
      const runtime = createOrderingOrderRuntimeForTest({
        db,
        eventStore,
        checkpointStore: createCheckpointStore(),
        shippingQuotePolicy: {
          quote: () => ({
            shippingOption: "standard",
            baseAmount: "4.99",
            discountAmount: "0.00",
            chargeAmount: "4.99",
          }),
        },
        ...(failure === "tax" ? { taxQuoteResolver: { quoteTax } } : {}),
        ...(failure === "authenticity" ? { authenticityFeePolicyResolver: { resolveAuthenticityFeePolicy } } : {}),
      });
      await expect(
        runtime.createOrdersFromCheckout(
          {
            buyerAccountId: context.audit.forAccountId,
            checkoutSessionId: "chk_preclaim",
            sourceType: "cart-checkout",
            shippingOption: "standard",
            shippingAddress,
            lines: [
              {
                listingId: null,
                cartLineId: "cli_1",
                catalogItemId: "cat_1",
                productId: "cat_1::",
                itemTitle: "Card",
                itemSubtitle: null,
                selectedOptions: [],
                productSummary: null,
                quantity: 1,
              },
            ],
            ...(failure === "authenticity"
              ? { authenticityCheckOptIn: { selected: true, quoteFingerprint: "quote" } }
              : {}),
            ...(failure === "order ids" ? { orderIdsOverride: [] } : {}),
          },
          context,
        ),
      ).rejects.toThrow(failure === "order ids" ? "Order seed overrides" : `${failure} unavailable`);
      if (failure === "tax") expect(quoteTax).toHaveBeenCalledTimes(2);
      if (failure === "authenticity") expect(resolveAuthenticityFeePolicy).toHaveBeenCalledTimes(2);
      expect(
        db.query.mock.calls.some(([sql]) =>
          /(?:INSERT INTO|UPDATE) ordering_(?:listing_purchase_limit|order_source_claims)/.test(sql),
        ),
      ).toBe(false);
      expect(readAllEvents()).toEqual([]);
    },
  );
});
