import type {
  CheckoutFulfillmentPreview,
  CheckoutInventoryReservationInput,
  CheckoutOrderLineSnapshot,
  CheckoutShippingAddressSnapshot,
  TaxQuote,
  TaxQuoteResolver,
} from "./runtime";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildPackagePlan,
  type PackagePlan,
  type PostagePolicy,
  type ProductMeasureSnapshot,
} from "@chase-sets/product-measures";
import { createId } from "@chase-sets/primitives/typed-ids";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { ListingEvidenceSnapshot } from "../../../support/request-support/listing-evidence";
import { addMoneyAmounts, centsToMoneyAmount, moneyToCents, sumMoneyAmounts } from "@chase-sets/primitives/money";
import {
  OrderingDomainError,
  buildDemandSignature,
  normalizeMoneyAmount,
  type OrderLineId,
  type OrderSourceType,
  type ShippingOption,
} from "../domain/common";
import {
  assertSupplyAvailable,
  calculateOrderFulfillmentEconomics,
  quoteMarketplaceSalesFeeFromSnapshot,
  type MarketplaceDemand,
  type MarketplaceSupplyCandidate,
  type MarketplaceSupplyFeeLock,
  type ShippingQuotePolicy,
} from "../domain/policies";
import { createFulfillmentDeliveryPromise } from "../domain/fulfillment-delivery-promise";
import {
  listOrderingSupplyCandidates,
  getOrderingSupplyCandidateByListingId,
} from "../integrations/supply/supply-queries";
import { applyPurchaseLimitAvailability } from "./purchase-limits";
import type { AuthenticityCheckFeeQuote } from "../domain/authenticity-check-fee";

type DemandAllocation = Readonly<{
  candidate: MarketplaceSupplyCandidate;
  quantity: number;
}>;

export type DemandPlan = Readonly<{
  demand: MarketplaceDemand;
  allocations: readonly DemandAllocation[];
}>;

export type SellerOrderDraft = Readonly<{
  sellerAccountId: string;
  sellerDisplayName: string | null;
  sourceType: OrderSourceType;
  sourceReferenceId: string | null;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  shippingBaseAmount: string;
  shippingDiscountAmount: string;
  shippingAllowanceAmount: string;
  shippingOverageAmount: string;
  sellerShippingPayoutAmount: string;
  protectionAmount: string;
  protectionAllowanceAmount: string;
  protectionOverageAmount: string;
  shippingChargeAmount: string;
  shippingPlanSnapshot: PackagePlan;
  salesTaxAmount: string;
  totalAmount: string;
  taxQuote: TaxQuote;
  shippingOriginSnapshot: AddressSnapshot;
  lines: ReadonlyArray<{
    lineId: OrderLineId;
    listingId: string;
    inventoryItemId: string;
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    productMeasureSnapshot: ProductMeasureSnapshot | null;
    gradedCard: MarketplaceSupplyCandidate["gradedCard"];
    unitPriceAmount: string;
    quantity: number;
    lineTotalAmount: string;
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    marketplaceSalesFeeCapAmount: string | null;
    marketplaceSalesFeeUnitAmount: string;
    marketplaceSalesFeeTotalAmount: string;
    sellerNetUnitAmount: string;
    sellerNetTotalAmount: string;
    listingEvidenceSnapshot?: ListingEvidenceSnapshot | null;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    shippingAllowancePercentageBps: number;
  }>;
  reservations: ReadonlyArray<{
    reservationRequestId: string;
    inventoryItemId: string;
    quantity: number;
    holdId?: string | null;
  }>;
}>;

export type CheckoutPlan = Readonly<{
  orderDrafts: readonly SellerOrderDraft[];
  totalAmount: bigint;
  itemSubtotalAmount: bigint;
  orderCount: number;
}>;

function groupDemands(cartLines: readonly CheckoutOrderLineSnapshot[]) {
  const grouped = new Map<string, MarketplaceDemand & Readonly<{ quantity: number }>>();

  for (const line of cartLines) {
    const key = buildDemandSignature(line.productId);
    const existing = grouped.get(key);

    if (existing) {
      grouped.set(key, { ...existing, quantity: existing.quantity + line.quantity });
      continue;
    }

    grouped.set(key, {
      catalogItemId: line.catalogItemId as CatalogItemId,
      productId: line.productId as ProductKey,
      itemTitle: line.itemTitle,
      itemSubtitle: line.itemSubtitle,
      selectedOptions: line.selectedOptions,
      productSummary: line.productSummary,
      quantity: line.quantity,
    });
  }

  return [...grouped.values()];
}

export function checkoutLineKey(line: CheckoutOrderLineSnapshot, index: number) {
  return line.cartLineId ?? line.lockedListingId ?? line.listingId ?? `${line.productId}:${index}`;
}

export function isLockedCheckoutLine(line: CheckoutOrderLineSnapshot) {
  return line.fulfillmentMode === "locked-listing" || Boolean((line.lockedListingId ?? line.listingId)?.trim());
}

function enumerateDemandAllocations(demand: MarketplaceDemand, candidates: readonly MarketplaceSupplyCandidate[]) {
  assertSupplyAvailable(candidates, demand.quantity, `Not enough active supply is available for ${demand.itemTitle}.`);

  const results: DemandPlan[] = [];
  const search = (index: number, remaining: number, chosen: DemandAllocation[]) => {
    if (remaining === 0) {
      results.push({ demand, allocations: [...chosen] });
      return;
    }
    if (index >= candidates.length) {
      return;
    }

    const candidate = candidates[index]!;
    const maxQuantity = Math.min(candidate.availableQuantity, remaining);

    for (let quantity = maxQuantity; quantity >= 0; quantity -= 1) {
      if (quantity > 0) {
        chosen.push({ candidate, quantity });
      }
      search(index + 1, remaining - quantity, chosen);
      if (quantity > 0) {
        chosen.pop();
      }
    }
  };

  search(0, demand.quantity, []);

  if (results.length === 0) {
    throw new OrderingDomainError(`Not enough active supply is available for ${demand.itemTitle}.`);
  }

  return results;
}

export function planShippingAllowanceBps(lines: SellerOrderDraft["lines"]) {
  const values = lines.map((line) => line.shippingAllowancePercentageBps);
  const unique = [...new Set(values)];
  if (values.length === 0) {
    return 500;
  }
  return unique.length === 1 ? (unique[0] ?? 500) : Math.min(...values);
}

function checkoutReservationKey(input: Pick<CheckoutInventoryReservationInput, "sellerAccountId" | "inventoryItemId">) {
  return `${input.sellerAccountId.trim()}|${input.inventoryItemId.trim()}`;
}

function checkoutReservationMap(reservations: readonly CheckoutInventoryReservationInput[] = []) {
  const map = new Map<string, CheckoutInventoryReservationInput[]>();
  for (const reservation of reservations) {
    const key = checkoutReservationKey(reservation);
    const existing = map.get(key) ?? [];
    existing.push(reservation);
    map.set(key, existing);
  }
  return map;
}

function consumeCheckoutReservationHoldId(
  reservations: Map<string, CheckoutInventoryReservationInput[]>,
  allocation: DemandAllocation,
) {
  const key = checkoutReservationKey({
    sellerAccountId: allocation.candidate.sellerAccountId,
    inventoryItemId: allocation.candidate.inventoryItemId,
  });
  const candidates = reservations.get(key);
  const index = candidates?.findIndex((reservation) => reservation.quantity === allocation.quantity) ?? -1;
  if (!candidates || index < 0) {
    return null;
  }

  const [reservation] = candidates.splice(index, 1);
  if (candidates.length === 0) {
    reservations.delete(key);
  }
  return reservation?.holdId ?? null;
}

function allocateCandidateFeeLocks(candidate: MarketplaceSupplyCandidate, quantity: number) {
  let remaining = quantity;
  const allocations: MarketplaceSupplyFeeLock[] = [];
  const feeLocks = candidate.feeLocks?.length
    ? candidate.feeLocks
    : [
        {
          unitCount: candidate.availableQuantity,
          marketplaceSalesFeeUnitAmount: candidate.marketplaceSalesFeeUnitAmount,
          sellerNetUnitAmount: candidate.sellerNetUnitAmount,
          shippingAllowancePercentageBps: candidate.shippingAllowancePercentageBps,
          termsScheduleId: candidate.termsScheduleId,
          termsAgreementId: candidate.termsAgreementId,
          termsResolvedAt: candidate.termsResolvedAt,
        },
      ];
  for (const lock of feeLocks) {
    if (remaining <= 0) break;
    const unitCount = Math.min(lock.unitCount, remaining);
    if (unitCount > 0) allocations.push({ ...lock, unitCount });
    remaining -= unitCount;
  }
  if (remaining !== 0) {
    throw new OrderingDomainError(`Listing ${candidate.listingId} does not have enough fee-locked units.`);
  }
  return allocations;
}

function quotePlan(
  demandPlans: readonly DemandPlan[],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
  postagePolicy: PostagePolicy,
  priceOverrideAmount?: string,
  feeOverride?: Readonly<{
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    marketplaceSalesFeeCapAmount: string | null;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    shippingAllowancePercentageBps?: number;
  }>,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId: string | null = null,
  checkoutReservations: readonly CheckoutInventoryReservationInput[] = [],
): CheckoutPlan {
  const availableCheckoutReservations = checkoutReservationMap(checkoutReservations);
  const groupedBySellerAndOrigin = new Map<
    string,
    {
      sellerAccountId: string;
      lines: Array<SellerOrderDraft["lines"][number]>;
      reservations: Array<SellerOrderDraft["reservations"][number]>;
      sellerDisplayName: string | null;
      shippingOriginSnapshot: AddressSnapshot;
      subtotalCents: bigint;
      listingIds: Set<string>;
      quantity: number;
    }
  >();

  for (const demandPlan of demandPlans) {
    for (const allocation of demandPlan.allocations) {
      const shippingOriginSnapshot = normalizeAddressSnapshot(allocation.candidate.shipFromAddress, "Shipping origin");
      const sellerGroupKey = [allocation.candidate.sellerAccountId, JSON.stringify(shippingOriginSnapshot)].join("|");
      const sellerDraft = groupedBySellerAndOrigin.get(sellerGroupKey) ?? {
        sellerAccountId: allocation.candidate.sellerAccountId,
        lines: [],
        reservations: [],
        sellerDisplayName: allocation.candidate.sellerDisplayName,
        shippingOriginSnapshot,
        subtotalCents: 0n,
        listingIds: new Set<string>(),
        quantity: 0,
      };
      const unitPriceAmount = priceOverrideAmount ?? allocation.candidate.priceAmount;
      const feeAllocations = feeOverride
        ? [
            {
              unitCount: allocation.quantity,
              marketplaceSalesFeePercentageBps: feeOverride.marketplaceSalesFeePercentageBps,
              marketplaceSalesFeeFixedAmount: feeOverride.marketplaceSalesFeeFixedAmount,
              marketplaceSalesFeeCapAmount: feeOverride.marketplaceSalesFeeCapAmount,
              marketplaceSalesFeeUnitAmount: feeOverride.marketplaceSalesFeeUnitAmount,
              sellerNetUnitAmount: feeOverride.sellerNetUnitAmount,
              shippingAllowancePercentageBps:
                feeOverride.shippingAllowancePercentageBps ?? allocation.candidate.shippingAllowancePercentageBps,
              termsScheduleId: feeOverride.termsScheduleId,
              termsAgreementId: feeOverride.termsAgreementId,
              termsResolvedAt: feeOverride.termsResolvedAt,
            },
          ]
        : allocateCandidateFeeLocks(allocation.candidate, allocation.quantity);
      for (const feeAllocation of feeAllocations) {
        const feeTerms = {
          marketplaceSalesFeePercentageBps: feeAllocation.marketplaceSalesFeePercentageBps ?? 0,
          marketplaceSalesFeeFixedAmount:
            feeAllocation.marketplaceSalesFeeFixedAmount ?? feeAllocation.marketplaceSalesFeeUnitAmount,
          marketplaceSalesFeeCapAmount: feeAllocation.marketplaceSalesFeeCapAmount ?? null,
        };
        const feeQuote = quoteMarketplaceSalesFeeFromSnapshot(unitPriceAmount, feeTerms);
        if (feeQuote.marketplaceSalesFeeUnitAmount !== feeAllocation.marketplaceSalesFeeUnitAmount) {
          throw new OrderingDomainError(
            `Listing ${allocation.candidate.listingId} fee snapshot does not reproduce its locked unit fee.`,
          );
        }
        const lineTotalAmount = centsToMoneyAmount(moneyToCents(unitPriceAmount) * BigInt(feeAllocation.unitCount));
        const marketplaceSalesFeeTotalAmount = centsToMoneyAmount(
          moneyToCents(feeQuote.marketplaceSalesFeeUnitAmount) * BigInt(feeAllocation.unitCount),
        );
        const sellerNetTotalAmount = centsToMoneyAmount(
          moneyToCents(feeQuote.sellerNetUnitAmount) * BigInt(feeAllocation.unitCount),
        );
        sellerDraft.lines.push({
          lineId: createId("oli") as OrderLineId,
          listingId: allocation.candidate.listingId,
          inventoryItemId: allocation.candidate.inventoryItemId,
          catalogItemId: allocation.candidate.catalogItemId,
          productId: allocation.candidate.productId,
          itemTitle: allocation.candidate.itemTitle,
          itemSubtitle: allocation.candidate.itemSubtitle,
          selectedOptions: [...allocation.candidate.selectedOptions],
          productSummary: allocation.candidate.productSummary,
          productMeasureSnapshot: allocation.candidate.productMeasureSnapshot,
          gradedCard: allocation.candidate.gradedCard,
          unitPriceAmount,
          quantity: feeAllocation.unitCount,
          lineTotalAmount,
          ...feeTerms,
          marketplaceSalesFeeUnitAmount: feeQuote.marketplaceSalesFeeUnitAmount,
          marketplaceSalesFeeTotalAmount,
          sellerNetUnitAmount: feeQuote.sellerNetUnitAmount,
          sellerNetTotalAmount,
          termsScheduleId: feeAllocation.termsScheduleId,
          termsAgreementId: feeAllocation.termsAgreementId,
          termsResolvedAt: feeAllocation.termsResolvedAt,
          shippingAllowancePercentageBps: feeAllocation.shippingAllowancePercentageBps,
        });
        sellerDraft.subtotalCents += moneyToCents(lineTotalAmount);
      }
      sellerDraft.reservations.push({
        reservationRequestId: createId("rsv"),
        inventoryItemId: allocation.candidate.inventoryItemId,
        quantity: allocation.quantity,
        holdId: consumeCheckoutReservationHoldId(availableCheckoutReservations, allocation),
      });
      sellerDraft.sellerDisplayName = sellerDraft.sellerDisplayName ?? allocation.candidate.sellerDisplayName;
      sellerDraft.listingIds.add(allocation.candidate.listingId);
      sellerDraft.quantity += allocation.quantity;
      groupedBySellerAndOrigin.set(sellerGroupKey, sellerDraft);
    }
  }

  const orderDrafts: SellerOrderDraft[] = [];
  let totalAmount = 0n;
  let itemSubtotalAmount = 0n;

  for (const draft of groupedBySellerAndOrigin.values()) {
    const shippingAllowancePercentageBps = planShippingAllowanceBps(draft.lines);
    const draftSubtotalAmount = centsToMoneyAmount(draft.subtotalCents);
    const packagePlan = buildPackagePlan({
      shippingOption,
      itemSubtotalAmount: draftSubtotalAmount,
      postagePolicy,
      lines: draft.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        measure: line.productMeasureSnapshot,
      })),
    });
    if (packagePlan.missingProductIds.length > 0) {
      throw new OrderingDomainError("Product measurements are required before checkout can be confirmed.");
    }
    const quote = shippingQuotePolicy.quote({
      sellerAccountId: draft.sellerAccountId,
      shippingOption,
      itemSubtotalAmount: draftSubtotalAmount,
      quantity: draft.quantity,
      listingCount: draft.listingIds.size,
      packagePlan,
    });
    const shippingEconomics = calculateOrderFulfillmentEconomics({
      itemSubtotalAmount: draftSubtotalAmount,
      shippingBaseAmount: quote.baseAmount,
      shippingAllowancePercentageBps,
    });
    const orderTotalCents = draft.subtotalCents + moneyToCents(shippingEconomics.shippingChargeAmount);
    totalAmount += orderTotalCents;
    itemSubtotalAmount += draft.subtotalCents;

    orderDrafts.push({
      sellerAccountId: draft.sellerAccountId,
      sellerDisplayName: draft.sellerDisplayName,
      sourceType,
      sourceReferenceId,
      shippingOption,
      itemSubtotalAmount: draftSubtotalAmount,
      shippingBaseAmount: shippingEconomics.shippingBaseAmount,
      shippingDiscountAmount: shippingEconomics.shippingDiscountAmount,
      shippingAllowanceAmount: shippingEconomics.shippingAllowanceAmount,
      shippingOverageAmount: shippingEconomics.shippingOverageAmount,
      sellerShippingPayoutAmount: shippingEconomics.sellerShippingPayoutAmount,
      protectionAmount: shippingEconomics.protectionAmount,
      protectionAllowanceAmount: shippingEconomics.protectionAllowanceAmount,
      protectionOverageAmount: shippingEconomics.protectionOverageAmount,
      shippingChargeAmount: shippingEconomics.shippingChargeAmount,
      shippingPlanSnapshot: quote.packagePlan ?? packagePlan,
      salesTaxAmount: "0.00",
      totalAmount: centsToMoneyAmount(orderTotalCents),
      taxQuote: {
        taxableAmount: "0.00",
        taxAmount: "0.00",
        jurisdictionCountry: "US",
        jurisdictionState: null,
        rateBps: 0,
        itemTaxable: false,
        shippingTaxable: false,
        marketplaceCheckoutFeeTaxable: false,
        providerName: "not-quoted",
        providerQuoteReference: null,
        quotedAt: new Date().toISOString(),
      },
      shippingOriginSnapshot: draft.shippingOriginSnapshot,
      lines: draft.lines,
      reservations: draft.reservations,
    });
  }

  return {
    orderDrafts: orderDrafts.sort((left, right) => left.sellerAccountId.localeCompare(right.sellerAccountId)),
    totalAmount,
    itemSubtotalAmount,
    orderCount: orderDrafts.length,
  };
}

export async function applyTaxToPlan(
  plan: CheckoutPlan,
  buyerAccountId: AccountId,
  shippingAddress: CheckoutShippingAddressSnapshot,
  taxQuoteResolver: TaxQuoteResolver,
): Promise<CheckoutPlan> {
  const orderDrafts: SellerOrderDraft[] = [];
  let totalAmount = 0n;

  for (const draft of plan.orderDrafts) {
    const taxQuote = await taxQuoteResolver.quoteTax({
      buyerAccountId,
      sellerAccountId: draft.sellerAccountId,
      currencyCode: "usd",
      destinationAddress: shippingAddress,
      itemSubtotalAmount: draft.itemSubtotalAmount,
      shippingAmount: draft.shippingChargeAmount,
    });
    const salesTaxAmount = normalizeMoneyAmount(taxQuote.taxAmount, {
      fieldName: "Sales tax amount",
      allowZero: true,
    });
    const orderTotal = sumMoneyAmounts([draft.itemSubtotalAmount, draft.shippingChargeAmount, salesTaxAmount]);
    totalAmount += moneyToCents(orderTotal);
    orderDrafts.push({
      ...draft,
      salesTaxAmount,
      totalAmount: orderTotal,
      taxQuote,
    });
  }

  return {
    ...plan,
    totalAmount,
    orderDrafts,
  };
}

export function chooseBestPlan(
  demandOptions: readonly DemandPlan[][],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
  postagePolicy: PostagePolicy,
  priceOverrideAmount?: string,
  feeOverride?: Readonly<{
    marketplaceSalesFeePercentageBps: number;
    marketplaceSalesFeeFixedAmount: string;
    marketplaceSalesFeeCapAmount: string | null;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    shippingAllowancePercentageBps?: number;
  }>,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId: string | null = null,
  optimizationGoal: "lowest-total" | "fewest-shipments" = "lowest-total",
  checkoutReservations: readonly CheckoutInventoryReservationInput[] = [],
) {
  let bestPlan: CheckoutPlan | null = null;
  const search = (index: number, chosen: DemandPlan[]) => {
    if (index >= demandOptions.length) {
      const plan = quotePlan(
        chosen,
        shippingOption,
        shippingQuotePolicy,
        postagePolicy,
        priceOverrideAmount,
        feeOverride,
        sourceType,
        sourceReferenceId,
        checkoutReservations,
      );
      const isBetter =
        optimizationGoal === "fewest-shipments"
          ? !bestPlan ||
            plan.orderCount < bestPlan.orderCount ||
            (plan.orderCount === bestPlan.orderCount && plan.totalAmount < bestPlan.totalAmount)
          : !bestPlan ||
            plan.totalAmount < bestPlan.totalAmount ||
            (plan.totalAmount === bestPlan.totalAmount && plan.itemSubtotalAmount < bestPlan.itemSubtotalAmount) ||
            (plan.totalAmount === bestPlan.totalAmount &&
              plan.itemSubtotalAmount === bestPlan.itemSubtotalAmount &&
              plan.orderCount < bestPlan.orderCount);
      if (isBetter) {
        bestPlan = plan;
      }
      return;
    }

    for (const option of demandOptions[index] ?? []) {
      chosen.push(option);
      search(index + 1, chosen);
      chosen.pop();
    }
  };

  search(0, []);
  if (!bestPlan) {
    throw new OrderingDomainError("No valid checkout plan could be created.");
  }
  return bestPlan;
}

export function planTermsForLines(
  lines: SellerOrderDraft["lines"],
  fieldName: "termsScheduleId" | "termsAgreementId" | "termsResolvedAt",
) {
  const values = [...new Set(lines.map((line) => line[fieldName]))];
  return values.length === 1 ? values[0] : null;
}

async function buildDemandOptions(
  db: PgQueryable,
  buyerAccountId: string | null,
  demandGroups: readonly MarketplaceDemand[],
  sellerAccountId?: string,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId = "",
) {
  const options: DemandPlan[][] = [];

  for (const demand of demandGroups) {
    const rawCandidates = await listOrderingSupplyCandidates(db, {
      ...demand,
      sellerAccountId,
    });
    const candidates = buyerAccountId
      ? await applyPurchaseLimitAvailability(db, buyerAccountId, rawCandidates, sourceType, sourceReferenceId)
      : rawCandidates;
    options.push(enumerateDemandAllocations(demand, candidates));
  }

  return options;
}

export async function buildCheckoutDemandOptions(
  db: PgQueryable,
  buyerAccountId: string,
  lines: readonly CheckoutOrderLineSnapshot[],
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId = "",
) {
  const optimizedLines = lines.filter((line) => !isLockedCheckoutLine(line));
  const options: DemandPlan[][] = [];

  for (const line of lines.filter(isLockedCheckoutLine)) {
    const lockedListingId = (line.lockedListingId ?? line.listingId ?? "").trim();
    if (!lockedListingId) {
      throw new OrderingDomainError("Locked checkout line must reference a listing.");
    }
    const candidate = await getOrderingSupplyCandidateByListingId(db, lockedListingId);
    if (!candidate) {
      throw new OrderingDomainError(`Locked listing is not available for ${line.itemTitle}.`);
    }
    if (candidate.productId !== line.productId.trim()) {
      throw new OrderingDomainError("Locked listing does not match the selected product.");
    }
    const limitedCandidates = await applyPurchaseLimitAvailability(
      db,
      buyerAccountId,
      [candidate],
      sourceType,
      sourceReferenceId,
    );
    const limitedCandidate = limitedCandidates[0] ?? candidate;
    assertSupplyAvailable(
      [limitedCandidate],
      line.quantity,
      `Not enough active supply is available for ${candidate.itemTitle}.`,
    );
    options.push([
      {
        demand: {
          catalogItemId: limitedCandidate.catalogItemId,
          productId: limitedCandidate.productId,
          itemTitle: limitedCandidate.itemTitle,
          itemSubtitle: limitedCandidate.itemSubtitle,
          selectedOptions: limitedCandidate.selectedOptions,
          productSummary: limitedCandidate.productSummary,
          quantity: line.quantity,
        },
        allocations: [{ candidate: limitedCandidate, quantity: line.quantity }],
      },
    ]);
  }

  if (optimizedLines.length > 0) {
    options.push(
      ...(await buildDemandOptions(
        db,
        buyerAccountId,
        groupDemands(optimizedLines),
        undefined,
        sourceType,
        sourceReferenceId,
      )),
    );
  }

  return options;
}

export function previewRevision(preview: Omit<CheckoutFulfillmentPreview, "revision">) {
  return [
    preview.optimizationGoal,
    preview.readyLineKeys.join(","),
    preview.unavailableLineKeys.join(","),
    preview.sellerGroups
      .map((group) =>
        [
          group.sellerAccountId,
          group.sellerDisplayName ?? "",
          group.totalAmount,
          group.postageRequirements.policyVersion,
          group.postageRequirements.parcelRequired ? "parcel" : "letter-eligible",
          group.postageRequirements.parcelReasons.join("+"),
          group.postageRequirements.signatureRequired ? "signature" : "no-signature",
          group.postageRequirements.signatureReasons.join("+"),
          group.postageRequirements.insuranceRequired ? "insurance" : "no-insurance",
          group.postageRequirements.insuranceReasons.join("+"),
          group.postageRequirements.insuredValueAmount ?? "",
          group.postageRequirements.shippingEvidenceTier,
          group.deliveryEstimate.earliestDate,
          group.deliveryEstimate.latestDate,
          group.deliveryEstimate.basis,
          group.lines
            .map((line) =>
              [
                line.lineKey,
                line.listingId,
                line.quantity,
                line.estimatedUnitPriceAmount,
                line.priceState,
                line.materialChangeReasons.join("+"),
              ].join(":"),
            )
            .join("|"),
        ].join("="),
      )
      .join(";"),
    preview.totals.totalAmount,
    preview.authenticityCheckOffer?.quote_fingerprint ?? "no-authenticity-check-offer",
  ].join("#");
}

function fulfillmentDeliveryPromiseForDraft(
  draft: SellerOrderDraft,
  shippingDestinationSnapshot: CheckoutShippingAddressSnapshot | null | undefined,
  authenticityCheckSelected?: boolean,
) {
  const postagePolicySnapshot = requirePostagePolicySnapshot(draft);
  const serviceLevels = [
    ...draft.shippingPlanSnapshot.packages.map((pkg) => pkg.serviceLevel),
    ...(postagePolicySnapshot.signatureRequired ? ["signature-required"] : []),
    ...(postagePolicySnapshot.insuranceRequired ? ["insurance-required"] : []),
    postagePolicySnapshot.shippingEvidenceTier,
  ];

  return createFulfillmentDeliveryPromise({
    shippingOption: draft.shippingOption,
    packageCount: draft.shippingPlanSnapshot.packageCount,
    serviceLevels,
    shipFrom: draft.shippingOriginSnapshot,
    shipTo: shippingDestinationSnapshot,
    authenticityCheckSelected,
  });
}

function requirePostagePolicySnapshot(draft: SellerOrderDraft) {
  const snapshot = draft.shippingPlanSnapshot.postagePolicySnapshot;
  if (!snapshot) {
    throw new OrderingDomainError("Shipping plan is missing a postage policy snapshot.");
  }
  return snapshot;
}

function postageRequirementsForDraft(draft: SellerOrderDraft) {
  const snapshot = requirePostagePolicySnapshot(draft);
  return {
    policyVersion: snapshot.policyVersion,
    parcelRequired: snapshot.parcelRequired,
    parcelReasons: snapshot.parcelReasons,
    signatureRequired: snapshot.signatureRequired,
    signatureReasons: snapshot.signatureReasons,
    insuranceRequired: snapshot.insuranceRequired,
    insuranceReasons: snapshot.insuranceReasons,
    insuredValueAmount: snapshot.insuredValueAmount,
    shippingEvidenceTier: snapshot.shippingEvidenceTier,
  };
}

export function planToPreview(
  params: Readonly<{
    plan: CheckoutPlan;
    sourceLines: readonly CheckoutOrderLineSnapshot[];
    optimizationGoal: "lowest-total" | "fewest-shipments";
    shippingDestinationSnapshot?: CheckoutShippingAddressSnapshot | null;
    unavailableLines: CheckoutFulfillmentPreview["unavailableLines"];
    authenticityCheckOptIn?: boolean;
    authenticityCheckOffer?: AuthenticityCheckFeeQuote | null;
  }>,
): CheckoutFulfillmentPreview {
  const lineKeysByDemand = new Map<string, string[]>();
  params.sourceLines.forEach((line, index) => {
    const key = buildDemandSignature(line.productId);
    lineKeysByDemand.set(key, [...(lineKeysByDemand.get(key) ?? []), checkoutLineKey(line, index)]);
  });

  const readyLineKeys = params.sourceLines
    .map(checkoutLineKey)
    .filter((key) => !params.unavailableLines.some((line) => line.lineKey === key));
  const sellerGroups = params.plan.orderDrafts.map((draft) => ({
    sellerAccountId: draft.sellerAccountId,
    sellerDisplayName: draft.sellerDisplayName,
    itemSubtotalAmount: draft.itemSubtotalAmount,
    shippingChargeAmount: draft.shippingChargeAmount,
    salesTaxAmount: draft.salesTaxAmount,
    totalAmount: draft.totalAmount,
    postageRequirements: postageRequirementsForDraft(draft),
    deliveryEstimate: fulfillmentDeliveryPromiseForDraft(
      draft,
      params.shippingDestinationSnapshot,
      params.authenticityCheckOptIn,
    ),
    lines: draft.lines.map((line) => {
      const demandKey = buildDemandSignature(line.productId);
      const lineKey = lineKeysByDemand.get(demandKey)?.shift() ?? line.listingId;
      const sourceLine = params.sourceLines.find((source, index) => checkoutLineKey(source, index) === lineKey);
      const locked = sourceLine ? isLockedCheckoutLine(sourceLine) : false;
      return {
        lineKey,
        listingId: line.listingId,
        sellerAccountId: draft.sellerAccountId,
        inventoryItemId: line.inventoryItemId,
        catalogItemId: line.catalogItemId,
        productId: line.productId,
        itemTitle: line.itemTitle,
        productSummary: line.productSummary,
        quantity: line.quantity,
        estimatedUnitPriceAmount: line.unitPriceAmount,
        estimatedLineTotalAmount: line.lineTotalAmount,
        priceState: locked ? ("locked" as const) : ("available" as const),
        materialChangeReasons: [] as string[],
      };
    }),
  }));
  const shippingAmount = sumMoneyAmounts(params.plan.orderDrafts.map((draft) => draft.shippingChargeAmount));
  const salesTaxAmount = sumMoneyAmounts(params.plan.orderDrafts.map((draft) => draft.salesTaxAmount));
  const materialChangeReasons = sellerGroups.flatMap((group) =>
    group.lines.flatMap((line) => line.materialChangeReasons),
  );
  // The payable total reflects the authenticity check fee only once the
  // buyer has actually opted in (not merely because the order is
  // eligible) -- otherwise the preview would overstate the total for
  // buyers who never selected it.
  const authenticityCheckFeeAmount =
    params.authenticityCheckOptIn && params.authenticityCheckOffer?.eligible
      ? params.authenticityCheckOffer.fee_amount
      : "0.00";
  const withoutRevision = {
    optimizationGoal: params.optimizationGoal,
    readyLineKeys,
    unavailableLineKeys: params.unavailableLines.map((line) => line.lineKey),
    sellerGroups,
    totals: {
      itemSubtotalAmount: centsToMoneyAmount(params.plan.itemSubtotalAmount),
      shippingAmount,
      salesTaxAmount,
      totalAmount: addMoneyAmounts(centsToMoneyAmount(params.plan.totalAmount), authenticityCheckFeeAmount),
      packageCount: params.plan.orderCount,
    },
    unavailableLines: params.unavailableLines,
    materialChangeReasons,
    authenticityCheckOffer: params.authenticityCheckOffer ?? null,
  };

  return {
    ...withoutRevision,
    revision: previewRevision(withoutRevision),
  };
}
