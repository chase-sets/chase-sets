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

const saleReviewRouteConfig: ReviewSubmissionRouteConfig = {
  orderParamName: "orderId",
  notFoundMessage: t("reputation.routes.marketplace.accountSaleReview.verified.order.not.found"),
  buildBackHref: (orderId) => `/account/sales/${orderId}`,
  buildSubmittedReviewRedirect: (review) => appendFreshWriteToken(`/account/reviews/${review.id}`, review),
};

export const loader = createReviewSubmissionLoader(saleReviewRouteConfig);
export const action = createReviewSubmissionAction(saleReviewRouteConfig);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountSaleReview.write.review.marketplace") });

export default function MarketplaceAccountSaleReviewRoute() {
  return <ReviewSubmissionRoute config={saleReviewRouteConfig} />;
}
