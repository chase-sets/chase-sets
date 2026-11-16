import { centsToMoneyAmount, moneyToCents, tryMoneyToCents } from "@chase-sets/primitives/money";
import type {
  CheckoutSellListCompositeReview,
  CheckoutSellListLineRow,
  CheckoutSellListRawReview,
  CheckoutSellPayoutReadinessRow,
} from "./queries";

export type SellListLineScreenReview = Readonly<{
  ready: boolean;
  canSubmit: boolean;
  labelCode: "ready" | "needs-refresh" | "needs-action" | "evidence-needs-action";
  detailCode:
    | "public-standard-preview-ready"
    | "selected-offer-ready"
    | "offer-terms-need-refresh"
    | "evidence-unavailable"
    | "evidence-incomplete"
    | "smart-match-ready"
    | "fallback-listing-ready"
    | "fallback-listing-form-ready"
    | "choose-sale-action";
  parameters: Readonly<{ count?: number }>;
  unmetEvidenceCodes: readonly string[];
  message: string | null;
  setupHref: string;
  inventoryHref: string;
  recoveryHref: string;
}>;

export type SellListScreenReview = Readonly<{
  lines: Readonly<Record<string, SellListLineScreenReview>>;
  lineCount: number;
  totalQuantity: number;
  readyLineCount: number;
  blockedLineCount: number;
  blockedSubmissionLineCount: number;
  canContinue: boolean;
  payoutIsReady: boolean;
  payoutReadiness: CheckoutSellPayoutReadinessRow | null;
  payoutSetupHref: string;
  recoveryHref: string;
  recoveryCode: "set-up-payouts" | "resolve-items" | "keep-selling";
  hasMultipleOffers: boolean;
  selectedOfferGross: string;
  futureListingGross: string;
  estimatedSalesFees: string | null;
  expectedSellerPayout: string | null;
}>;

function positivePrice(value: string | null | undefined) {
  return value ? (tryMoneyToCents(value) ?? 0n) > 0n : false;
}

function setupTargets(line: CheckoutSellListLineRow, inventoryItemId?: string) {
  const inventoryParams = new URLSearchParams({
    catalogItemId: line.catalog_catalog_item_id,
    returnTo: "/account/sell-list",
  });
  const listingParams = inventoryItemId
    ? new URLSearchParams({ inventoryItemId })
    : new URLSearchParams({ catalogItemId: line.catalog_catalog_item_id });
  const price = line.line_type === "selected-offer" ? line.offer_price_amount : line.minimum_listing_price_amount;
  if (price && positivePrice(price)) listingParams.set("recommendedPrice", price);
  if (line.selected_options.length > 0) {
    inventoryParams.set("selectedOptions", JSON.stringify(line.selected_options));
    if (!inventoryItemId) listingParams.set("selectedOptions", JSON.stringify(line.selected_options));
  }
  const inventoryHref = `/account/inventory?${inventoryParams.toString()}`;
  const setupHref = `/account/listings/new?${listingParams.toString()}`;
  return { setupHref, inventoryHref, recoveryHref: line.line_type === "product" && !inventoryItemId ? inventoryHref : setupHref };
}

// Screen answers are read-only hints, never confirmation authority.
export function deriveSellListCompositeReview(options: Readonly<{
  lines: readonly CheckoutSellListLineRow[];
  review: CheckoutSellListRawReview;
  isAccount: boolean;
  payoutReadiness?: CheckoutSellPayoutReadinessRow | null;
  sellListPath?: string;
}>): CheckoutSellListCompositeReview {
  const { lines, review } = options;
  const selected = new Map(review.offerReviews.map((item) => [item.lineId, item]));
  const products = new Map(review.productOfferReviews.map((item) => [item.lineId, item]));
  const inventory = new Map<string, string>();
  for (const item of review.inventoryItems) {
    if (!inventory.has(item.product_id)) inventory.set(item.product_id, item.item_id);
  }
  const lineAnswers: Record<string, SellListLineScreenReview> = {};
  let gross = 0n;
  let futureGross = 0n;
  let fees = 0n;
  let payout = 0n;
  let unquoted = false;
  let hasMultipleOffers = false;
  for (const line of lines) {
    const selectedReview = selected.get(line.line_id);
    const productReview = products.get(line.line_id);
    const offers = productReview?.offers ?? [];
    const inventoryItemId = inventory.get(line.product_id);
    const targets = setupTargets(line, line.line_type === "product" ? inventoryItemId : undefined);
    const base = { ...targets, parameters: {}, unmetEvidenceCodes: [], message: null };
    let answer: SellListLineScreenReview;
    if (line.line_type === "selected-offer") {
      const termsReady = selectedReview?.status === "ready" && Boolean(selectedReview.terms);
      const evidence = selectedReview?.evidence;
      answer = !termsReady
        ? { ...base, ready: false, canSubmit: false, labelCode: "needs-refresh", detailCode: "offer-terms-need-refresh", message: selectedReview?.message ?? null }
        : evidence === null || (evidence && !evidence.coverage.complete)
          ? { ...base, ready: false, canSubmit: false, labelCode: "evidence-needs-action", detailCode: evidence === null ? "evidence-unavailable" : "evidence-incomplete", unmetEvidenceCodes: evidence?.coverage.unmetCodes ?? [] }
          : { ...base, ready: true, canSubmit: true, labelCode: "ready", detailCode: selectedReview?.terms && "source_kind" in selectedReview.terms && selectedReview.terms.source_kind === "public-standard-seller-terms" ? "public-standard-preview-ready" : "selected-offer-ready" };
      gross += moneyToCents(line.offer_price_amount ?? "0") * BigInt(line.quantity);
      if (!selectedReview?.terms) unquoted = true;
      else {
        fees += moneyToCents(selectedReview.terms.marketplace_sales_fee_unit_amount) * BigInt(line.quantity);
        payout += moneyToCents(selectedReview.terms.seller_net_unit_amount) * BigInt(line.quantity);
      }
    } else {
      const blockedOffer = offers.find((item) => item.evidence !== undefined && (!item.evidence || !item.evidence.coverage.complete));
      const fallbackReady = line.fallback_mode === "create-listing" && Boolean(inventoryItemId) && positivePrice(line.minimum_listing_price_amount);
      const ready = offers.length > 0 || Boolean(inventoryItemId);
      answer = blockedOffer
        ? { ...base, ready: false, canSubmit: false, labelCode: "evidence-needs-action", detailCode: blockedOffer.evidence === null ? "evidence-unavailable" : "evidence-incomplete", unmetEvidenceCodes: blockedOffer.evidence?.coverage.unmetCodes ?? [] }
        : ready
          ? { ...base, ready: true, canSubmit: true, labelCode: "ready", detailCode: offers.length > 0 ? "smart-match-ready" : fallbackReady ? "fallback-listing-ready" : "fallback-listing-form-ready", parameters: offers.length > 0 ? { count: offers.length } : {} }
          : { ...base, ready: false, canSubmit: false, labelCode: "needs-action", detailCode: "choose-sale-action", message: productReview?.message ?? null };
      hasMultipleOffers ||= offers.length > 1;
      unquoted ||= offers.length === 0;
      let matchedQuantity = 0;
      for (const { offer, terms } of offers) {
        matchedQuantity += offer.quantity_requested;
        fees += moneyToCents(terms.marketplace_sales_fee_unit_amount) * BigInt(offer.quantity_requested);
        payout += moneyToCents(terms.seller_net_unit_amount) * BigInt(offer.quantity_requested);
      }
      const fallbackQuantity = line.fallback_mode === "create-listing" ? Math.max(0, line.quantity - matchedQuantity) : 0;
      futureGross += moneyToCents(line.minimum_listing_price_amount ?? "0") * BigInt(fallbackQuantity);
    }
    lineAnswers[line.line_id] = answer;
  }
  const answers = lines.map((line) => lineAnswers[line.line_id]!);
  const blockedLineCount = answers.filter((answer) => !answer.ready).length;
  const blockedSubmissionLineCount = answers.filter((answer) => !answer.canSubmit).length;
  const firstBlockedLine = lines.find((line) => !lineAnswers[line.line_id]!.canSubmit) ?? lines.find((line) => !lineAnswers[line.line_id]!.ready);
  const payoutReadiness = options.isAccount ? options.payoutReadiness ?? null : null;
  const payoutIsReady = !options.isAccount || payoutReadiness?.status === "ready";
  const payoutSetupHref = `/account/payouts/setup?returnTo=${encodeURIComponent(options.sellListPath ?? "/account/sell-list")}`;
  return { ...review, screen: {
    lines: lineAnswers,
    lineCount: lines.length,
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    readyLineCount: lines.length - blockedLineCount,
    blockedLineCount,
    blockedSubmissionLineCount,
    canContinue: payoutIsReady && blockedSubmissionLineCount === 0 && lines.length > 0,
    payoutIsReady,
    payoutReadiness,
    payoutSetupHref,
    recoveryHref: !payoutIsReady ? payoutSetupHref : firstBlockedLine ? lineAnswers[firstBlockedLine.line_id]!.recoveryHref : "/search",
    recoveryCode: !payoutIsReady ? "set-up-payouts" : blockedLineCount > 0 ? "resolve-items" : "keep-selling",
    hasMultipleOffers,
    selectedOfferGross: centsToMoneyAmount(gross),
    futureListingGross: centsToMoneyAmount(futureGross),
    estimatedSalesFees: unquoted ? null : centsToMoneyAmount(fees),
    expectedSellerPayout: unquoted ? null : centsToMoneyAmount(payout),
  } };
}
