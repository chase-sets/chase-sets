import { t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { moneyNumber } from "./sell-list-formatting";
import {
  productLineCanSubmitCheckout,
  productLineReadiness,
  selectedOfferReadiness,
  sellListLineRecoveryHref,
} from "./sell-list-readiness";
import type {
  PayoutReadiness,
  SellListInventoryItem,
  SellListOfferReview,
  SellListProductOfferReview,
} from "./sell-list-page-types";

export type SellListPageModelInput = Readonly<{
  sellListLines: readonly CheckoutSellListLineRow[];
  isSignedIn: boolean;
  offerReviews: readonly SellListOfferReview[];
  productOfferReviews: readonly SellListProductOfferReview[];
  inventoryItems: readonly SellListInventoryItem[];
  payoutReadiness: PayoutReadiness | null;
}>;

/** Every derived value for the sell-list page — the model half of the
 * model-hook + view split (mirrors discovery/features/item-detail's
 * use-item-detail-page-model). The view renders these fields as plain
 * values; it never recomputes readiness or totals itself. */
export function useSellListPageModel({
  sellListLines,
  isSignedIn,
  offerReviews,
  productOfferReviews,
  inventoryItems,
  payoutReadiness,
}: SellListPageModelInput) {
  const selectedOfferLines = sellListLines.filter((line) => line.line_type === "selected-offer");
  const productLines = sellListLines.filter((line) => line.line_type === "product");
  const offerReviewsByLineId = new Map((offerReviews ?? []).map((review) => [review.lineId, review]));
  const productOfferReviewsByLineId = new Map((productOfferReviews ?? []).map((review) => [review.lineId, review]));
  const inventoryByProductId = new Map<string, SellListInventoryItem[]>();
  for (const item of inventoryItems ?? []) {
    inventoryByProductId.set(item.product_id, [...(inventoryByProductId.get(item.product_id) ?? []), item]);
  }

  const totalQuantity = sellListLines.reduce((sum, line) => sum + line.quantity, 0);
  const selectedOfferGross = selectedOfferLines.reduce(
    (sum, line) => sum + moneyNumber(line.offer_price_amount) * line.quantity,
    0,
  );
  const selectedOfferSellerNet = selectedOfferLines.reduce((sum, line) => {
    const review = offerReviewsByLineId.get(line.line_id);
    return sum + moneyNumber(review?.terms?.seller_net_unit_amount ?? line.offer_price_amount) * line.quantity;
  }, 0);
  const smartMatchSellerNet = productLines.reduce((sum, line) => {
    const review = productOfferReviewsByLineId.get(line.line_id);
    return (
      sum +
      (review?.offers ?? []).reduce(
        (offerSum, { offer, terms }) => offerSum + moneyNumber(terms.seller_net_unit_amount) * offer.quantity_requested,
        0,
      )
    );
  }, 0);
  const futureListingGross = productLines.reduce((sum, line) => {
    const review = productOfferReviewsByLineId.get(line.line_id);
    const matchedQuantity = (review?.offers ?? []).reduce(
      (quantity, item) => quantity + item.offer.quantity_requested,
      0,
    );
    const fallbackQuantity = line.fallback_mode === "create-listing" ? Math.max(0, line.quantity - matchedQuantity) : 0;
    return sum + moneyNumber(line.minimum_listing_price_amount) * fallbackQuantity;
  }, 0);
  const estimatedSalesFees =
    selectedOfferLines.reduce((sum, line) => {
      const review = offerReviewsByLineId.get(line.line_id);
      return sum + moneyNumber(review?.terms?.marketplace_sales_fee_unit_amount) * line.quantity;
    }, 0) +
    productLines.reduce((sum, line) => {
      const review = productOfferReviewsByLineId.get(line.line_id);
      return (
        sum +
        (review?.offers ?? []).reduce(
          (offerSum, { offer, terms }) =>
            offerSum + moneyNumber(terms.marketplace_sales_fee_unit_amount) * offer.quantity_requested,
          0,
        )
      );
    }, 0);
  const expectedSellerPayout = selectedOfferSellerNet + smartMatchSellerNet;
  const lineReadiness = sellListLines.map((line) =>
    line.line_type === "selected-offer"
      ? selectedOfferReadiness(offerReviewsByLineId.get(line.line_id))
      : productLineReadiness({
          line,
          review: productOfferReviewsByLineId.get(line.line_id),
          defaultInventoryItem: inventoryByProductId.get(line.product_id)?.[0] ?? null,
        }),
  );
  const lineCanSubmitCheckout = sellListLines.map((line) =>
    line.line_type === "selected-offer"
      ? selectedOfferReadiness(offerReviewsByLineId.get(line.line_id)).ready
      : productLineCanSubmitCheckout({
          review: productOfferReviewsByLineId.get(line.line_id),
          defaultInventoryItem: inventoryByProductId.get(line.product_id)?.[0] ?? null,
        }),
  );
  const blockedLineCount = lineReadiness.filter((readiness) => !readiness.ready).length;
  const blockedSubmissionLineCount = lineCanSubmitCheckout.filter((canSubmit) => !canSubmit).length;
  const readyLineCount = sellListLines.length - blockedLineCount;
  const payoutIsReady = isSignedIn ? payoutReadiness?.status === "ready" : true;
  const canContinue = payoutIsReady && blockedSubmissionLineCount === 0 && sellListLines.length > 0;
  const firstBlockedLine =
    sellListLines.find((line, index) => !lineCanSubmitCheckout[index]) ??
    sellListLines.find((line, index) => !lineReadiness[index]?.ready) ??
    null;
  const firstBlockedLineHref = firstBlockedLine
    ? sellListLineRecoveryHref(firstBlockedLine, inventoryByProductId.get(firstBlockedLine.product_id)?.[0] ?? null)
    : null;
  const recoveryHref = !payoutIsReady
    ? "/account/payouts/setup?returnTo=%2Faccount%2Fsell-list"
    : (firstBlockedLineHref ?? "/search");
  const recoveryLabel = !payoutIsReady
    ? t("checkout.features.sellList.ui.sellListPage.set.up.payouts")
    : blockedLineCount > 0
      ? t("checkout.features.sellList.ui.sellListPage.resolve.items")
      : t("checkout.features.sellList.ui.sellListPage.keep.selling");
  const primarySellerCheckoutLabel = isSignedIn
    ? t("checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout")
    : t("checkout.features.sellList.ui.sellListPage.create.account.to.continue");
  const readinessSummary =
    blockedLineCount > 0
      ? t("checkout.features.sellList.ui.sellListPage.readiness.needs.action", { count: blockedLineCount })
      : t("checkout.features.sellList.ui.sellListPage.readiness.ready", { count: readyLineCount });

  return {
    selectedOfferLines,
    productLines,
    offerReviewsByLineId,
    productOfferReviewsByLineId,
    inventoryByProductId,
    totalQuantity,
    selectedOfferGross,
    futureListingGross,
    estimatedSalesFees,
    expectedSellerPayout,
    blockedLineCount,
    canContinue,
    recoveryHref,
    recoveryLabel,
    primarySellerCheckoutLabel,
    readinessSummary,
  };
}
