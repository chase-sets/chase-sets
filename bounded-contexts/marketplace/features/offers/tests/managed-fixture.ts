import { vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createMarketplaceOfferRuntime } from "../api/runtime";
import { createBuyerOfferPolicyRuntime } from "../../offer-policy/api/runtime";
import { context, seedOffer, terms } from "../../offer-policy/tests/fixtures";
import type { ManagedOfferPricing, ManagedOfferTarget } from "../api/managed-authority";

export async function managedFixture(store: EventStore, allowance = "30.00", pricing?: ManagedOfferPricing) {
  const db = {
    query: vi.fn(async () => ({
      rows: [
        {
          offer_id: "off_one",
          buyer_account_id: "acc_buyer",
          catalog_catalog_item_id: "cat_one",
          product_id: "cat_one::",
          item_title: "Item",
          selected_options: [],
          price_amount: "10.00",
          price_currency_code: "USD",
          quantity_requested: 2,
          status: "submitted",
          seller_available_quantity: 100,
          listing_visible_quantity: 100,
          listing_quantity_cap: 100,
          listing_price_amount: "10.00",
          listing_price_currency_code: "USD",
          seller_listing_availability_status: "available",
        },
      ],
      rowCount: 1,
    })),
  };
  let target: ManagedOfferTarget = { status: "target", unitItemAmount: "10.00", evidence: { estimateVersion: "1" } };
  const evaluateTargets = vi.fn<ManagedOfferPricing["evaluateTargets"]>(async (requests) => requests.map(() => target));
  const offers = createMarketplaceOfferRuntime({
    eventStore: store,
    db,
    checkpointStore: {} as never,
    managedOfferPricing: pricing ?? { evaluateTargets },
    commercialTermsResolver: {
      resolveListingTerms: async ({ amount }: { amount: string }) => ({
        accountType: "personal",
        basisAmount: amount,
        marketplaceSalesFeeUnitAmount: "0.00",
        sellerNetUnitAmount: amount,
        marketplaceSalesFeePercentageBps: 0,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: null,
        shippingAllowancePercentageBps: 500,
        scheduleId: "sch_test",
        agreementId: null,
        resolvedAt: new Date().toISOString(),
      }),
    } as never,
    listingEvidencePolicyEvaluator: {
      evaluate: async () => ({
        policyId: "pol_test",
        policyVersion: 1,
        policyHash: "test",
        matchedRuleIds: [],
        requirements: {
          minimumPhotoCount: 0,
          requiredSlots: [],
          sellerTrustRequirements: [],
          buyerAcknowledgment: "none",
        },
        effectiveInterval: { from: "2026-01-01T00:00:00.000Z", until: null },
        explanationCodes: [],
      }),
    },
  });
  const policies = createBuyerOfferPolicyRuntime({ eventStore: store, db, enforcement: { assertInstalled() {} } });
  for (const id of ["off_one", "off_two"]) await seedOffer(store, id);
  for (const suffix of ["one", "two"])
    await store.appendToStream({
      streamId: `marketplace.listing-lst_${suffix}`,
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "marketplace.listing.created",
          payload: {
            listingId: `lst_${suffix}`,
            accountId: `acc_${suffix}`,
            inventoryItemId: `inv_${suffix}`,
            catalogItemId: "cat_one",
            productId: "cat_one::",
            itemTitle: "Item",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            productMeasureSnapshot: null,
            gradedCard: null,
            storageLocationName: "Warehouse",
            shipFromCode: "CHI",
            shipFromAddress: null,
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            marketplaceSalesFeeUnitAmount: "0.00",
            sellerNetUnitAmount: "10.00",
            shippingAllowancePercentageBps: 500,
            termsScheduleId: "sch_test",
            termsAgreementId: null,
            termsResolvedAt: "2026-01-01T00:00:00.000Z",
            feeQuoteFingerprint: "test",
            feeLocks: [],
            quantityCap: 100,
            purchaseLimits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
            evidenceRequirements: null,
            evidence: [],
          },
        },
        { eventType: "marketplace.listing.published", payload: {} },
      ],
    });
  await policies.execute(
    "bop_one",
    { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: "create" },
    context,
  );
  const preview = await policies.execute(
    "bop_one",
    {
      type: "PreviewBuyerOfferPolicy",
      expectedVersion: 1,
      operationId: "preview",
      terms: {
        ...terms,
        itemCommitmentAllowance: allowance,
        offers: [terms.offers[0]!, { ...terms.offers[0]!, offerId: "off_two" }],
      },
    },
    context,
  );
  await policies.execute(
    "bop_one",
    {
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: 2,
      operationId: "authorize",
      previewId: preview.preview!.previewId,
      consent: true,
    },
    context,
  );
  async function acceptance(suffix = "one") {
    const params = {
      offerId: `off_${suffix}` as never,
      listingId: `lst_${suffix}`,
      sellerAccountId: `acc_${suffix}` as never,
    };
    const quote = await offers.previewOfferAcceptanceTerms(params);
    return { ...params, feeQuoteFingerprint: quote.fee_quote_fingerprint };
  }
  return {
    offers,
    policies,
    store,
    db,
    evaluateTargets,
    acceptance,
    setTarget(value: ManagedOfferTarget) {
      target = value;
    },
  };
}
