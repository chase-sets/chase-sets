import { t } from "@chase-sets/localization";
import type { CheckoutSellListCompositeReview } from "../read-model/queries";

export type SellListPageModelInput = Readonly<{
  isSignedIn: boolean;
  compositeReview: CheckoutSellListCompositeReview | null;
}>;

const recoveryKeys = {
  "set-up-payouts": "checkout.features.sellList.ui.sellListPage.set.up.payouts",
  "resolve-items": "checkout.features.sellList.ui.sellListPage.resolve.items",
  "keep-selling": "checkout.features.sellList.ui.sellListPage.keep.selling",
} as const;

export function useSellListPageModel({ isSignedIn, compositeReview }: SellListPageModelInput) {
  const screen = compositeReview?.screen;
  const inventoryByProductId = new Map<string, CheckoutSellListCompositeReview["inventoryItems"][number][]>();
  for (const item of compositeReview?.inventoryItems ?? []) {
    const items = inventoryByProductId.get(item.product_id) ?? [];
    items.push(item);
    inventoryByProductId.set(item.product_id, items);
  }
  return {
    lineCount: 0,
    totalQuantity: 0,
    readyLineCount: 0,
    blockedLineCount: 0,
    blockedSubmissionLineCount: 0,
    canContinue: false,
    payoutIsReady: false,
    payoutSetupHref: "",
    recoveryHref: "",
    hasMultipleOffers: false,
    selectedOfferGross: null,
    futureListingGross: null,
    estimatedSalesFees: null,
    expectedSellerPayout: null,
    ...screen,
    offerReviewsByLineId: new Map(compositeReview?.offerReviews?.map((review) => [review.lineId, review])),
    productOfferReviewsByLineId: new Map(
      compositeReview?.productOfferReviews?.map((review) => [review.lineId, review]),
    ),
    inventoryByProductId,
    expectedSellerPayoutLabel: t(
      screen?.hasMultipleOffers
        ? "checkout.features.sellList.ui.sellListPage.expected.seller.payout.all.offers"
        : "checkout.features.sellList.ui.sellListPage.expected.seller.payout",
    ),
    recoveryLabel: screen ? t(recoveryKeys[screen.recoveryCode]) : "",
    primarySellerCheckoutLabel: t(
      isSignedIn
        ? "checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout"
        : "checkout.features.sellList.ui.sellListPage.create.account.to.continue",
    ),
    readinessSummary: screen
      ? screen.blockedLineCount > 0
        ? t("checkout.features.sellList.ui.sellListPage.readiness.needs.action", { count: screen.blockedLineCount })
        : t("checkout.features.sellList.ui.sellListPage.readiness.ready", { count: screen.readyLineCount })
      : "",
  };
}
