import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "@chase-sets/identity/server";
import {
  ReputationApiError,
  ReputationReviewDetailPage,
  type ReputationReviewDetail,
} from "../../web";
import { createReputationRequestApiClient } from "../../client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromIdentityApi({
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
