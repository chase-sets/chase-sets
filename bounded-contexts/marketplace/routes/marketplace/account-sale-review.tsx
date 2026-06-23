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

const SALE_REVIEW_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-sale-review",
  routeId: "account-sale-review",
  routeTemplate: "/account/sales/:orderId/review",
} as const satisfies PlatformPostWriteTelemetry;

const saleReviewRouteConfig: ReviewSubmissionRouteConfig = {
  orderParamName: "orderId",
  notFoundMessage: t("reputation.routes.marketplace.accountSaleReview.verified.order.not.found"),
  buildBackHref: (orderId) => `/account/sales/${orderId}`,
  buildSubmittedReviewRedirect: (review) =>
    navigateAfterWrite(review, `/account/reviews/${review.id}`, {
      telemetry: SALE_REVIEW_POST_WRITE_TELEMETRY,
    }),
};

export const loader = createReviewSubmissionLoader(saleReviewRouteConfig);
export const action = createReviewSubmissionAction(saleReviewRouteConfig);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountSaleReview.write.review.marketplace") });

export default function MarketplaceAccountSaleReviewRoute() {
  return <ReviewSubmissionRoute config={saleReviewRouteConfig} />;
}
