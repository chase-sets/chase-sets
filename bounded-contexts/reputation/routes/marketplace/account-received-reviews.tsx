import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { LinkButton, Stack } from "@chase-sets/design-system";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type ReviewListItem,
} from "../../support/request-support/api-client";
import { createReputationRequestApiClient } from "../../support/request-support/api-client";
import { ReviewListPage } from "../../features/reviews/ui/review-list-page";

const DEFAULT_REVIEW_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  return {
    reviews: await api.listReceivedReviews(DEFAULT_REVIEW_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountReceivedReviews.received.reviews.marketplace") });

export default function MarketplaceAccountReceivedReviewsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <ReviewListPage
      title={t("reputation.routes.marketplace.accountReceivedReviews.received.reviews")}
      eyebrow={t("reputation.routes.marketplace.accountReceivedReviews.reviews")}
      emptyTitle={t("reputation.routes.marketplace.accountReceivedReviews.no.received.reviews.yet")}
      emptyDescription={t("reputation.routes.marketplace.accountReceivedReviews.counterparty.feedback.about.your.completed.transactions")}
      reviewDetailBasePath="/account/reviews"
      reviews={(data.reviews as ListResponse<ReviewListItem>).items}
      actions={
        <Stack direction="row" gap={2}>
          <LinkButton href="/account/reviews" tone="secondary">
            {t("reputation.routes.marketplace.accountReceivedReviews.summary")}</LinkButton>
          <LinkButton href="/account/reviews/written" tone="secondary">
            {t("reputation.routes.marketplace.accountReceivedReviews.written.reviews")}</LinkButton>
        </Stack>
      }
    />
  );
}
