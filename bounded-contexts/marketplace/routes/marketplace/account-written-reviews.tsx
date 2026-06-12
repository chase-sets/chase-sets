import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { LinkButton, Stack } from "@chase-sets/design-system";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type ReviewListItem } from "../../support/request-support/reputation-api-client";
import { createReputationRequestApiClient } from "../../support/request-support/reputation-api-client";
import { ReviewListPage } from "../../features/reviews/ui/review-list-page";

const DEFAULT_REVIEW_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  return {
    reviews: await api.listWrittenReviews(DEFAULT_REVIEW_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountWrittenReviews.written.reviews.marketplace") });

export default function MarketplaceAccountWrittenReviewsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <ReviewListPage
      title={t("reputation.routes.marketplace.accountWrittenReviews.written.reviews")}
      eyebrow={t("reputation.routes.marketplace.accountWrittenReviews.reviews")}
      emptyTitle={t("reputation.routes.marketplace.accountWrittenReviews.no.written.reviews.yet")}
      emptyDescription={t(
        "reputation.routes.marketplace.accountWrittenReviews.reviews.you.leave.after.completed.transactions",
      )}
      reviewDetailBasePath="/account/reviews"
      reviews={(data.reviews as ListResponse<ReviewListItem>).items}
      actions={
        <Stack direction="row" gap={2}>
          <LinkButton href="/account/reviews" tone="secondary">
            {t("reputation.routes.marketplace.accountWrittenReviews.summary")}
          </LinkButton>
          <LinkButton href="/account/reviews/received" tone="secondary">
            {t("reputation.routes.marketplace.accountWrittenReviews.received.reviews")}
          </LinkButton>
        </Stack>
      }
    />
  );
}
