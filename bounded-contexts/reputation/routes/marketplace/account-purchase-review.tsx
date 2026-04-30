import type { MetaFunction } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createReviewSubmissionAction,
  createReviewSubmissionLoader,
  ReviewSubmissionRoute,
  type ReviewSubmissionRouteConfig,
} from "../../support/route-support/review-submission-route";

const purchaseReviewRouteConfig: ReviewSubmissionRouteConfig = {
  orderParamName: "purchaseId",
  notFoundMessage: "Verified purchase not found.",
  buildBackHref: (orderId) => `/account/purchases/${orderId}`,
};

export const loader = createReviewSubmissionLoader(purchaseReviewRouteConfig);
export const action = createReviewSubmissionAction(purchaseReviewRouteConfig);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Write Review | Marketplace" });

export default function MarketplaceAccountPurchaseReviewRoute() {
  return <ReviewSubmissionRoute config={purchaseReviewRouteConfig} />;
}
