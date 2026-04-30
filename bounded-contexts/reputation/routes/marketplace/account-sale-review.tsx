import type { MetaFunction } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createReviewSubmissionAction,
  createReviewSubmissionLoader,
  ReviewSubmissionRoute,
  type ReviewSubmissionRouteConfig,
} from "../../support/route-support/review-submission-route";

const saleReviewRouteConfig: ReviewSubmissionRouteConfig = {
  orderParamName: "orderId",
  notFoundMessage: "Verified order not found.",
  buildBackHref: (orderId) => `/account/sales/${orderId}`,
};

export const loader = createReviewSubmissionLoader(saleReviewRouteConfig);
export const action = createReviewSubmissionAction(saleReviewRouteConfig);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Write Review | Marketplace" });

export default function MarketplaceAccountSaleReviewRoute() {
  return <ReviewSubmissionRoute config={saleReviewRouteConfig} />;
}
