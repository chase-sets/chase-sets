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
import {
  ReputationApiError,
  ReputationReviewSubmissionPage,
  type ReputationReviewOpportunity,
} from "@chase-sets/reputation/web";
import { createMarketplaceReputationApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

function parseFeedback(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}

function parseRating(value: FormDataEntryValue | null) {
  return Number(value ?? 0);
}

async function loadOpportunity(request: Request, orderId: string) {
  const api = createMarketplaceReputationApiClient(request);

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
  await requireMarketplaceActor(request, "reputation.manage");

  return {
    opportunity: await loadOpportunity(request, params.orderId!),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireMarketplaceActor(request, "reputation.manage");
  const formData = await request.formData();
  const rating = parseRating(formData.get("rating"));
  const feedback = parseFeedback(formData.get("feedback"));
  const api = createMarketplaceReputationApiClient(request);

  try {
    const opportunity = await api.getOrderReviewOpportunity(params.orderId!);
    if (opportunity.active_review_id) {
      return redirect(`/account/reviews/${opportunity.active_review_id}`);
    }

    const review = await api.submitReview({
      orderId: params.orderId!,
      subjectAccountId: opportunity.subject_account_id,
      rating,
      feedback,
    });

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
  buildMarketplaceMeta({ title: "Write Review | Marketplace" });

export default function MarketplaceAccountOrderReviewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
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
