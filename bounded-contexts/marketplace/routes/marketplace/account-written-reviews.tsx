import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { LinkButton, Stack } from "@chase-sets/design-system";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type ReviewListItem } from "../../support/request-support/reputation-api-client";
import { createReputationRequestApiClient } from "../../support/request-support/reputation-api-client";
import { ReviewListPage } from "../../features/reviews/ui/review-list-page";
import { submitReviewReport } from "../../support/route-support/review-report-action";
import type { ReviewReportResult } from "../../features/reviews/ui/review-report-action";

const DEFAULT_REVIEW_QUERY = "limit=100&offset=0";
const REVIEW_ROLES = new Set(["seller", "buyer"]);

function roleFromRequest(request: Request): "seller" | "buyer" | null {
  const role = new URL(request.url).searchParams.get("role");
  return role && REVIEW_ROLES.has(role) ? (role as "seller" | "buyer") : null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);
  const role = roleFromRequest(request);
  const query = role ? `${DEFAULT_REVIEW_QUERY}&role=${role}` : DEFAULT_REVIEW_QUERY;

  return {
    role,
    reviews: await api.listWrittenReviews(query),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "reputation.manage" });
  return submitReviewReport(request);
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountWrittenReviews.written.reviews.marketplace") });

export default function MarketplaceAccountWrittenReviewsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ReviewReportResult | undefined;
  const navigation = useNavigation();
  const submittingReportId =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "report-review"
      ? String(navigation.formData.get("reviewId") ?? "")
      : null;

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
      reportResult={actionData}
      submittingReportId={submittingReportId}
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
      roleFilterActions={
        <Stack direction="row" gap={2}>
          <LinkButton href="/account/reviews/written" tone={data.role === null ? "primary" : "secondary"}>
            {t("reputation.routes.marketplace.accountWrittenReviews.all.roles")}
          </LinkButton>
          <LinkButton
            href="/account/reviews/written?role=seller"
            tone={data.role === "seller" ? "primary" : "secondary"}
          >
            {t("reputation.routes.marketplace.accountWrittenReviews.as.seller")}
          </LinkButton>
          <LinkButton href="/account/reviews/written?role=buyer" tone={data.role === "buyer" ? "primary" : "secondary"}>
            {t("reputation.routes.marketplace.accountWrittenReviews.as.buyer")}
          </LinkButton>
        </Stack>
      }
    />
  );
}
