import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { loadFreshlyWrittenResource } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { ReputationApiError, type ReviewDetail } from "../../support/request-support/api-client";
import { createReputationRequestApiClient } from "../../support/request-support/api-client";
import { ReviewDetailPage } from "../../features/reviews/ui/review-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  try {
    return await loadFreshlyWrittenResource({
      request,
      isNotFound: (error) => error instanceof ReputationApiError && error.status === 404,
      load: async () => ({
        review: await api.getAccountReview(params.reviewId!),
      }),
    });
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountReview.review.marketplace") });

export default function MarketplaceAccountReviewRoute() {
  const data = useLoaderData<typeof loader>();

  return <ReviewDetailPage backHref="/account/reviews/received" review={data.review as ReviewDetail} />;
}
