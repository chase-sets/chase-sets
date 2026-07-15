import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createReputationRequestApiClient,
  ReputationApiError,
  type ReviewOpportunity,
} from "../request-support/reputation-api-client";
import { ReviewSubmissionPage } from "../../features/reviews/ui/review-submission-page";

type ReviewSubmissionActionData = Readonly<{
  error: string;
  values: Readonly<{
    rating: number;
    feedback: string;
  }>;
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
    if (opportunity.active_review_id) {
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
      const opportunity = await api.getOrderReviewOpportunity(orderId);
      if (opportunity.active_review_id) {
        return redirect(`/account/reviews/${opportunity.active_review_id}`);
      }

      const review = (await api.submitReview({
        orderId,
        subjectAccountId: opportunity.subject_account_id,
        rating,
        feedback,
      })) as SubmittedReviewSnapshot;

      return redirect(config.buildSubmittedReviewRedirect(review));
    } catch (error) {
      if (error instanceof ReputationApiError && error.status === 404) {
        throw new Response(config.notFoundMessage, { status: 404 });
      }

      return {
        error: error instanceof Error ? error.message : "Review could not be submitted.",
        values: {
          rating,
          feedback,
        },
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
      isSubmitting={navigation.state === "submitting"}
      defaultRating={actionData?.values?.rating ?? 5}
      defaultFeedback={actionData?.values?.feedback ?? ""}
      resolution={{ intakeAvailable }}
    />
  );
}
