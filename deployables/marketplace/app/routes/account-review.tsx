import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  ReputationApiError,
  ReputationReviewDetailPage,
  type ReputationReviewDetail,
} from "@chase-sets/reputation/web";
import { createMarketplaceReputationApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "reputation.view");
  const api = createMarketplaceReputationApiClient(request);

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
  buildMarketplaceMeta({ title: "Review | Marketplace" });

export default function MarketplaceAccountReviewRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <ReputationReviewDetailPage
      backHref="/account/reviews/received"
      review={data.review as ReputationReviewDetail}
    />
  );
}
