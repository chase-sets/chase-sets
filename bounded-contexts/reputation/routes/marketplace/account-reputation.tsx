import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { LinkButton, Stack } from "@chase-sets/design-system";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type ReputationAccountSummary,
  type ReputationReviewListItem,
} from "../../request-support/api-client";
import { createReputationRequestApiClient } from "../../request-support/api-client";
import { ReputationAccountPage } from "../../reviews/ui/account-reputation-page";

const DEFAULT_REVIEW_QUERY = "limit=10&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  return {
    summary: await api.getAccountReputation(actor.accountId),
    reviews: await api.listAccountReviews(actor.accountId, DEFAULT_REVIEW_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Reputation | Marketplace" });

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
