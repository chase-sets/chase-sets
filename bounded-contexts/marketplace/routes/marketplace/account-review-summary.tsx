import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { LinkButton, Stack } from "@chase-sets/design-system";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type ReviewSummary, type ReviewListItem } from "../../support/request-support/reputation-api-client";
import { createReputationRequestApiClient } from "../../support/request-support/reputation-api-client";
import { ReviewSummaryPage } from "../../features/reviews/ui/account-review-summary-page";
import { submitReviewReport } from "../../support/route-support/review-report-action";
import type { ReviewReportResult } from "../../features/reviews/ui/review-report-action";

const DEFAULT_REVIEW_QUERY = "limit=10&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  return {
    summary: await api.getAccountReviewSummary(actor.accountId),
    reviews: await api.listAccountReviews(actor.accountId, DEFAULT_REVIEW_QUERY),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "reputation.manage" });
  return submitReviewReport(request);
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountReviewSummary.reviews.marketplace") });

export default function MarketplaceAccountReviewSummaryRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ReviewReportResult | undefined;
  const navigation = useNavigation();
  const submittingReportId =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "report-review"
      ? String(navigation.formData.get("reviewId") ?? "")
      : null;
  const summary = data.summary as ReviewSummary;

  return (
    <ReviewSummaryPage
      accountLabel={
        summary.account_display_name ?? t("reputation.routes.marketplace.accountReviewSummary.your.reviews")
      }
      summary={summary}
      reviews={(data.reviews as ListResponse<ReviewListItem>).items}
      reportResult={actionData}
      submittingReportId={submittingReportId}
      actions={
        <Stack direction="row" gap={2}>
          <LinkButton href="/account/reviews/received" tone="secondary">
            {t("reputation.routes.marketplace.accountReviewSummary.received.reviews")}
          </LinkButton>
          <LinkButton href="/account/reviews/written" tone="secondary">
            {t("reputation.routes.marketplace.accountReviewSummary.written.reviews")}
          </LinkButton>
        </Stack>
      }
    />
  );
}
