import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { LinkButton, Stack } from "@chase-sets/design-system";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  ReputationAccountPage,
  type ReputationAccountSummary,
  type ReputationReviewListItem,
} from "@chase-sets/reputation/web";
import { createMarketplaceReputationApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_REVIEW_QUERY = "limit=10&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "reputation.view");
  const api = createMarketplaceReputationApiClient(request);

  return {
    summary: await api.getAccountReputation(actor.accountId),
    reviews: await api.listAccountReviews(actor.accountId, DEFAULT_REVIEW_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Reputation | Marketplace" });

export default function MarketplaceAccountReputationRoute() {
  const data = useLoaderData<typeof loader>();
  const summary = data.summary as ReputationAccountSummary;

  return (
    <ReputationAccountPage
      accountLabel={summary.account_display_name ?? "Your reputation"}
      summary={summary}
      reviews={(data.reviews as ListResponse<ReputationReviewListItem>).items}
      actions={
        <Stack direction="row" gap={2}>
          <LinkButton href="/account/reviews/received" tone="secondary">
            Received reviews
          </LinkButton>
          <LinkButton href="/account/reviews/written" tone="secondary">
            Written reviews
          </LinkButton>
        </Stack>
      }
    />
  );
}
