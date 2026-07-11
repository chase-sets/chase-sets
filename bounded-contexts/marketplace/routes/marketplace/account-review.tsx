import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import { classifyPostWriteDestinationResult } from "@chase-sets/http/responses";
import { loadAfterWrite, navigateAfterWrite, type PlatformPostWriteTelemetry } from "@chase-sets/platform-runtime/http";
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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "reputation.view",
  });
  const api = createReputationRequestApiClient(request);

  const reviewRead = await loadAfterWrite({
    request,
    isNotFound: (error) => error instanceof ReputationApiError && error.status === 404,
    load: async () => ({
      review: await api.getAccountReview(params.reviewId!),
      viewerAccountId: actor.accountId,
    }),
    telemetry: ACCOUNT_REVIEW_POST_WRITE_TELEMETRY,
  });
  const reviewDestination = classifyPostWriteDestinationResult(reviewRead);

  if (reviewDestination.kind === "recover") {
    return {
      review: null,
      viewerAccountId: actor.accountId,
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
