import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import {
  defineFormAction,
  defineResourceRoute,
  formActionRedirect,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { ReputationApiError, type ReviewDetail } from "../../support/request-support/reputation-api-client";
import { createReputationRequestApiClient } from "../../support/request-support/reputation-api-client";
import { ReviewDetailPage, ReviewDetailRecoveryPage } from "../../features/reviews/ui/review-detail-page";
import contextManifest from "../../context.json";
import { marketplaceApiErrorAdapter } from "../../support/request-support/route-api-error";
import { submitReviewReport } from "../../support/route-support/review-report-action";
import type { ReviewReportResult } from "../../features/reviews/ui/review-report-action";

const ACCOUNT_REVIEW_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-review",
  routeId: "account-review",
  routeTemplate: "/account/reviews/:reviewId",
} as const satisfies PlatformPostWriteTelemetry;

type ReviewReplyActionData = Readonly<{
  error: string;
  values: Readonly<{ feedback: string }>;
}>;

function replyErrorMessage(error: unknown): string {
  if (error instanceof ReputationApiError) {
    const body = error.body as Readonly<{ error?: Readonly<{ message?: unknown }> }> | null;
    const message = body?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : t("reputation.routes.marketplace.accountReview.reply.failed");
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-review",
  authorization: { permission: "reputation.view" },
  errorAdapter: marketplaceApiErrorAdapter,
  load: async ({ request, params, actor }) => ({
    review: await createReputationRequestApiClient(request).getAccountReview(params.reviewId!),
    viewerAccountId: actor!.accountId,
  }),
  map: (result) => result,
  onPending: (_result, { actor }) => ({
    review: null,
    viewerAccountId: actor!.accountId,
    recovery: "fresh-write-preparing" as const,
  }),
  messages: { notFound: t("reputation.routes.marketplace.accountReview.review.not.found") },
  telemetry: ACCOUNT_REVIEW_POST_WRITE_TELEMETRY,
});

export const action = defineFormAction({
  authorization: { permission: "reputation.manage" },
  intents: {
    "report-review": ({ request, formData }) => submitReviewReport(request, formData),
    reply: async ({ request, params, formData }) => {
      const reviewId = params.reviewId;
      if (!reviewId) {
        throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
      }
      const feedbackEntry = formData.get("feedback");
      const feedback = typeof feedbackEntry === "string" ? feedbackEntry : "";
      const reply = (await createReputationRequestApiClient(request).submitReviewReply(reviewId, {
        feedback,
      })) as Readonly<{ id: string }>;
      return formActionRedirect(reply, `/account/reviews/${reviewId}`, {
        telemetry: ACCOUNT_REVIEW_POST_WRITE_TELEMETRY,
      });
    },
  },
  onUnknownIntent: () => null,
  onError: (error, { formData }) => {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
    }
    const feedbackEntry = formData.get("feedback");
    return {
      error: replyErrorMessage(error),
      values: { feedback: typeof feedbackEntry === "string" ? feedbackEntry : "" },
    } satisfies ReviewReplyActionData;
  },
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountReview.review.marketplace") });

function reviewRoleForViewer(review: ReviewDetail, viewerAccountId: string) {
  const authorRole = review.author_role === "seller" ? "seller" : "buyer";
  return review.author_account_id === viewerAccountId ? authorRole : authorRole === "buyer" ? "seller" : "buyer";
}

export default function MarketplaceAccountReviewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ReviewReplyActionData | ReviewReportResult | undefined;
  const location = useLocation();
  const navigation = useNavigation();
  const reportResult = actionData && "reviewId" in actionData ? (actionData as ReviewReportResult) : null;
  const replyResult = actionData && !("reviewId" in actionData) ? actionData : null;
  const submittingIntent = navigation.formData?.get("intent");

  if (!data.review) {
    return <ReviewDetailRecoveryPage currentPath={`${location.pathname}${location.search}`} />;
  }

  const review = data.review as ReviewDetail;
  const role = reviewRoleForViewer(review, data.viewerAccountId);
  const ownsReview = review.author_account_id === data.viewerAccountId;
  const backHref = `/account/reviews/${ownsReview ? "written" : "received"}?role=${role}`;
  const orderHref = role === "buyer" ? `/account/purchases/${review.order_id}` : `/account/sales/${review.order_id}`;

  return (
    <ReviewDetailPage
      backHref={backHref}
      orderHref={orderHref}
      review={review}
      viewerAccountId={data.viewerAccountId}
      replyErrorMessage={replyResult?.error ?? null}
      isSubmittingReply={navigation.state === "submitting" && submittingIntent !== "report-review"}
      defaultReplyFeedback={replyResult?.values?.feedback ?? ""}
      reportResult={reportResult}
      isSubmittingReport={navigation.state === "submitting" && submittingIntent === "report-review"}
    />
  );
}
