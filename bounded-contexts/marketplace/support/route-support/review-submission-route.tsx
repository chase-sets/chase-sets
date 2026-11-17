import type { ActionFunctionArgs, LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createReputationRequestApiClient,
  ReputationApiError,
  type ReviewOpportunity,
} from "../request-support/reputation-api-client";
import { ReviewSubmissionPage } from "../../features/reviews/ui/review-submission-page";
import { runReviewMutation } from "./review-mutation-action";
import {
  authoredTextRecoveryFromApiError,
  type AuthoredTextRecovery,
} from "../../features/reviews/ui/authored-text-recovery";

type ReviewSubmissionActionData = Readonly<{
  error: string;
  attemptId?: string;
  mutationPhase?: "failed-safe";
  values: Readonly<{
    rating: number;
    feedback: string;
  }>;
  recovery?: AuthoredTextRecovery;
}>;

type ReviewSubmissionLoaderData = Readonly<{
  opportunity: ReviewOpportunity;
}>;

type SubmittedReviewSnapshot = Readonly<{ id: string }>;

export type ReviewSubmissionRouteConfig = Readonly<{
  orderParamName: string;
  notFoundMessage: string;
  buildBackHref: (orderId: string) => string;
  buildSubmittedReviewRedirect: (review: SubmittedReviewSnapshot) => string;
}>;

function parseFeedback(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}

function parseRating(value: FormDataEntryValue | null) {
  return Number(value ?? 0);
}

function getOrderId(params: LoaderFunctionArgs["params"], config: ReviewSubmissionRouteConfig) {
  const orderId = params[config.orderParamName];
  if (!orderId) {
    throw new Response(config.notFoundMessage, { status: 404 });
  }

  return orderId;
}

async function loadOpportunity(request: Request, orderId: string, notFoundMessage: string) {
  const api = createReputationRequestApiClient(request);

  try {
    const opportunity = await api.getOrderReviewOpportunity(orderId);
    if (request.method === "GET" && opportunity.active_review_id) {
      throw redirect(`/account/reviews/${opportunity.active_review_id}`);
    }

    return opportunity;
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response(notFoundMessage, { status: 404 });
    }

    throw error;
  }
}

export function createReviewSubmissionLoader(config: ReviewSubmissionRouteConfig) {
  return async function reviewSubmissionLoader({
    request,
    params,
  }: LoaderFunctionArgs): Promise<ReviewSubmissionLoaderData> {
    await requireActorFromAuthApi({
      request,
      permission: "reputation.manage",
    });

    return {
      opportunity: await loadOpportunity(request, getOrderId(params, config), config.notFoundMessage),
    };
  };
}

export function createReviewSubmissionAction(config: ReviewSubmissionRouteConfig) {
  return async function reviewSubmissionAction({ request, params }: ActionFunctionArgs) {
    await requireActorFromAuthApi({
      request,
      permission: "reputation.manage",
    });
    const orderId = getOrderId(params, config);
    const formData = await request.formData();
    const rating = parseRating(formData.get("rating"));
    const feedback = parseFeedback(formData.get("feedback"));
    const api = createReputationRequestApiClient(request);

    try {
      const subjectAccountId = String(formData.get("subjectAccountId") ?? (await api.getOrderReviewOpportunity(orderId)).subject_account_id);
      const body = {
        attemptId: String(formData.get("attemptId") ?? ""),
        orderId,
        subjectAccountId,
        rating,
        feedback,
      };
      const outcome = await runReviewMutation({
        formData, kind: "review.submit", target: orderId, request: body,
        send: () => api.submitReview(body),
        lookup: api.lookupMutationAttempt,
        isResponse: (error) => error instanceof ReputationApiError,
        code: (error) => error instanceof ReputationApiError ? (error.body as { error?: { code?: string } })?.error?.code ?? null : null,
      });
      if (!("result" in outcome)) return { ...outcome, values: { rating, feedback } };
      const review = outcome.result as { id: string };
      return redirect(config.buildSubmittedReviewRedirect(review));
    } catch (error) {
      if (error instanceof ReputationApiError && error.status === 404) {
        throw new Response(config.notFoundMessage, { status: 404 });
      }

      const recovery = error instanceof ReputationApiError ? authoredTextRecoveryFromApiError(error.body) : null;
      return {
        attemptId: String(formData.get("attemptId") ?? ""),
        mutationPhase: "failed-safe",
        error: recovery?.message ?? (error instanceof Error ? error.message : "Review could not be submitted."),
        values: {
          rating,
          feedback,
        },
        ...(recovery ? { recovery } : {}),
      } satisfies ReviewSubmissionActionData;
    }
  };
}

export function ReviewSubmissionRoute({ config }: { config: ReviewSubmissionRouteConfig }) {
  const data = useLoaderData() as ReviewSubmissionLoaderData;
  const actionData = useActionData() as ReviewSubmissionActionData | undefined;
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  // The canonical order-issue intake owns eligibility and outage handling; when
  // it bounces a buyer back because a new issue cannot be opened, it flags the
  // funnel so the review flow explains why and keeps eligible feedback open.
  const intakeAvailable = searchParams.get("resolution") !== "intake-unavailable";

  return (
    <ReviewSubmissionPage
      backHref={config.buildBackHref(data.opportunity.order_id)}
      opportunity={data.opportunity}
      errorMessage={actionData?.error ?? null}
      feedbackRecovery={actionData?.recovery ?? null}
      isSubmitting={navigation.state === "submitting"}
      defaultRating={actionData?.values?.rating ?? 5}
      defaultFeedback={actionData?.values?.feedback ?? ""}
      resolution={{ intakeAvailable }}
    />
  );
}

export function shouldRevalidateReviewSubmission({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return actionResult?.mutationPhase ? false : defaultShouldRevalidate;
}
