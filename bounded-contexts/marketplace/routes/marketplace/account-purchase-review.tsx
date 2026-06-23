import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { navigateAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createReviewSubmissionAction,
  createReviewSubmissionLoader,
  ReviewSubmissionRoute,
  type ReviewSubmissionRouteConfig,
} from "../../support/route-support/review-submission-route";

const PURCHASE_REVIEW_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-purchase-review",
  routeId: "account-purchase-review",
  routeTemplate: "/account/purchases/:purchaseId/review",
} as const satisfies PlatformPostWriteTelemetry;

const purchaseReviewRouteConfig: ReviewSubmissionRouteConfig = {
  orderParamName: "purchaseId",
  notFoundMessage: t("reputation.routes.marketplace.accountPurchaseReview.verified.purchase.not.found"),
  buildBackHref: (orderId) => `/account/purchases/${orderId}`,
  buildSubmittedReviewRedirect: (review) =>
    navigateAfterWrite(review, `/account/reviews/${review.id}`, {
      telemetry: PURCHASE_REVIEW_POST_WRITE_TELEMETRY,
    }),
};

export const loader = createReviewSubmissionLoader(purchaseReviewRouteConfig);
export const action = createReviewSubmissionAction(purchaseReviewRouteConfig);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountPurchaseReview.write.review.marketplace") });

export default function MarketplaceAccountPurchaseReviewRoute() {
  return <ReviewSubmissionRoute config={purchaseReviewRouteConfig} />;
}
