import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import {
  defineResourceRoute,
  navigateAfterWrite,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { ReputationApiError, type ReviewDetail } from "../../support/request-support/reputation-api-client";
import { createReputationRequestApiClient } from "../../support/request-support/reputation-api-client";
import { ReviewDetailPage, ReviewDetailRecoveryPage } from "../../features/reviews/ui/review-detail-page";
import contextManifest from "../../context.json";
import { marketplaceApiErrorAdapter } from "../../support/request-support/route-api-error";

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

// Subject reply compose (m108): posts the one threaded subject response for
// this review. The API's domain decider is authoritative for the subject-only,
// post-reveal, and one-reply-per-review rules; this action just forwards the
// form and surfaces validation failures back onto the compose form.
export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.manage",
  });
  const reviewId = params.reviewId;
  if (!reviewId) {
    throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
  }

  const formData = await request.formData();
  const feedbackEntry = formData.get("feedback");
  const feedback = typeof feedbackEntry === "string" ? feedbackEntry : "";
  const api = createReputationRequestApiClient(request);

  try {
    const reply = (await api.submitReviewReply(reviewId, { feedback })) as Readonly<{ id: string }>;

    return redirect(
      navigateAfterWrite(reply, `/account/reviews/${reviewId}`, {
        telemetry: ACCOUNT_REVIEW_POST_WRITE_TELEMETRY,
      }),
    );
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response(t("reputation.routes.marketplace.accountReview.review.not.found"), { status: 404 });
    }

    return {
      error: replyErrorMessage(error),
      values: { feedback },
    } satisfies ReviewReplyActionData;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("reputation.routes.marketplace.accountReview.review.marketplace") });

export default function MarketplaceAccountReviewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ReviewReplyActionData | undefined;
  const location = useLocation();
  const navigation = useNavigation();

  if (!data.review) {
    return <ReviewDetailRecoveryPage currentPath={`${location.pathname}${location.search}`} />;
  }

  return (
    <ReviewDetailPage
      backHref="/account/reviews/received"
      review={data.review as ReviewDetail}
      viewerAccountId={data.viewerAccountId}
      replyErrorMessage={actionData?.error ?? null}
      isSubmittingReply={navigation.state === "submitting"}
      defaultReplyFeedback={actionData?.values?.feedback ?? ""}
    />
  );
}
