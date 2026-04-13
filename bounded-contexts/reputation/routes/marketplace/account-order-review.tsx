import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  ReputationApiError,
  type ReputationReviewOpportunity,
} from "../../support/request-support/api-client";
import { createReputationRequestApiClient } from "../../support/request-support/api-client";
import { ReputationReviewSubmissionPage } from "../../features/reviews/ui/review-submission-page";

type ReviewActionData = Readonly<{
  error: string;
  values: Readonly<{
    rating: number;
    feedback: string;
  }>;
}>;

function parseFeedback(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}

function parseRating(value: FormDataEntryValue | null) {
  return Number(value ?? 0);
}

async function loadOpportunity(request: Request, orderId: string) {
  const api = createReputationRequestApiClient(request);

  try {
    const opportunity = await api.getOrderReviewOpportunity(orderId);
    if (opportunity.active_review_id) {
      throw redirect(`/account/reviews/${opportunity.active_review_id}`);
    }

    return opportunity;
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response("Verified order not found.", { status: 404 });
    }

    throw error;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.manage",
  });

  return {
    opportunity: await loadOpportunity(request, params.orderId!),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "reputation.manage",
  });
  const formData = await request.formData();
  const rating = parseRating(formData.get("rating"));
  const feedback = parseFeedback(formData.get("feedback"));
  const api = createReputationRequestApiClient(request);

  try {
    const opportunity = await api.getOrderReviewOpportunity(params.orderId!);
    if (opportunity.active_review_id) {
      return redirect(`/account/reviews/${opportunity.active_review_id}`);
    }

    const review = (await api.submitReview({
      orderId: params.orderId!,
      subjectAccountId: opportunity.subject_account_id,
      rating,
      feedback,
    })) as Readonly<{ id: string }>;

    return redirect(`/account/reviews/${review.id}`);
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      throw new Response("Verified order not found.", { status: 404 });
    }

    return {
      error: error instanceof Error ? error.message : "Review could not be submitted.",
      values: {
        rating,
        feedback,
      },
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Write Review | Marketplace" });

export default function MarketplaceAccountOrderReviewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as ReviewActionData | undefined;
  const navigation = useNavigation();

  return (
    <ReputationReviewSubmissionPage
      backHref={`/account/orders/${data.opportunity.order_id}`}
      opportunity={data.opportunity as ReputationReviewOpportunity}
      errorMessage={actionData?.error ?? null}
      isSubmitting={navigation.state === "submitting"}
      defaultRating={actionData?.values?.rating ?? 5}
      defaultFeedback={actionData?.values?.feedback ?? ""}
    />
  );
}
