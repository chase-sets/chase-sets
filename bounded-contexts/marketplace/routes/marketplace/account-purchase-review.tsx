import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createReviewSubmissionAction,
  createReviewSubmissionLoader,
  ReviewSubmissionRoute,
  type ReviewSubmissionRouteConfig,
} from "../../support/route-support/review-submission-route";

const purchaseReviewRouteConfig: ReviewSubmissionRouteConfig = {
  orderParamName: "purchaseId",
  notFoundMessage: t("reputation.routes.marketplace.accountPurchaseReview.verified.purchase.not.found"),
  buildBackHref: (orderId) => `/account/purchases/${orderId}`,
  buildSubmittedReviewRedirect: (review) => appendFreshWriteToken(`/account/reviews/${review.id}`, review),
};

export const loader = createReviewSubmissionLoader(purchaseReviewRouteConfig);
export const action = createReviewSubmissionAction(purchaseReviewRouteConfig);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountPurchaseReview.write.review.marketplace") });

export default function MarketplaceAccountPurchaseReviewRoute() {
  return <ReviewSubmissionRoute config={purchaseReviewRouteConfig} />;
}
