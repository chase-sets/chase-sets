import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  ReputationApiError,
  type ReputationReviewDetail,
} from "../../request-support/api-client";
import { createReputationRequestApiClient } from "../../request-support/api-client";
import { ReputationReviewDetailPage } from "../../reviews/ui/review-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  try {
    return {
      review: await api.getAccountReview(params.reviewId!),
    };
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response("Review not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Review | Marketplace" });

export default function MarketplaceAccountReviewRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <ReputationReviewDetailPage
      backHref="/account/reviews/received"
      review={data.review as ReputationReviewDetail}
    />
  );
}
