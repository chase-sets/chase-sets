import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useLocation } from "react-router";
import { classifyPostWriteDestinationResult } from "@chase-sets/http/responses";
import { loadAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { ReputationApiError, type ReviewDetail } from "../../support/request-support/reputation-api-client";
import { createReputationRequestApiClient } from "../../support/request-support/reputation-api-client";
import { ReviewDetailPage, ReviewDetailRecoveryPage } from "../../features/reviews/ui/review-detail-page";

const ACCOUNT_REVIEW_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-review",
  routeId: "account-review",
  routeTemplate: "/account/reviews/:reviewId",
} as const satisfies PlatformPostWriteTelemetry;

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  const reviewRead = await loadAfterWrite({
    request,
    isNotFound: (error) => error instanceof ReputationApiError && error.status === 404,
    load: async () => ({
      review: await api.getAccountReview(params.reviewId!),
    }),
    telemetry: ACCOUNT_REVIEW_POST_WRITE_TELEMETRY,
  });
  const reviewDestination = classifyPostWriteDestinationResult(reviewRead);

  if (reviewDestination.kind === "recover") {
    return {
      review: null,
      recovery: "fresh-write-preparing" as const,
    };
  }

  if (reviewDestination.kind === "pass-through") {
    const error = "error" in reviewDestination.result ? reviewDestination.result.error : null;
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
    }

    if (error) {
      throw error;
    }

    throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
  }

  return reviewDestination.data;
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountReview.review.marketplace") });

export default function MarketplaceAccountReviewRoute() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();

  if (!data.review) {
    return <ReviewDetailRecoveryPage currentPath={`${location.pathname}${location.search}`} />;
  }

  return <ReviewDetailPage backHref="/account/reviews/received" review={data.review as ReviewDetail} />;
}
