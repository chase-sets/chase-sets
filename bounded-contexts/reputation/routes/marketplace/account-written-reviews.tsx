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
    reviews: await api.listWrittenReviews(DEFAULT_REVIEW_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Written Reviews | Marketplace" });

export default function MarketplaceAccountWrittenReviewsRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <ReviewListPage
      title="Written Reviews"
      eyebrow="Reviews"
      emptyTitle="No written reviews yet"
      emptyDescription="Reviews you leave after completed transactions appear here."
      reviewDetailBasePath="/account/reviews"
      reviews={(data.reviews as ListResponse<ReviewListItem>).items}
      actions={
        <Stack direction="row" gap={2}>
          <LinkButton href="/account/reviews" tone="secondary">
            Summary
          </LinkButton>
          <LinkButton href="/account/reviews/received" tone="secondary">
            Received reviews
          </LinkButton>
        </Stack>
      }
    />
  );
}
