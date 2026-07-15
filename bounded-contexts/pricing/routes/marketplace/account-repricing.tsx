import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../../support/request-support/api-client";
import { PricingRecommendationListPage } from "../../features/recommendations/ui/recommendation-list-page";
import type { PricingRecommendationJobStatus } from "../../features/recommendations/api/runtime";

const DEFAULT_RECOMMENDATION_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "pricing.view",
  });
  const api = createPricingRequestApiClient(request);
  const activeJobId = new URL(request.url).searchParams.get("jobId") ?? "";
  const activeJob = activeJobId ? await loadActiveRecommendationJob(api, activeJobId) : null;

  return {
    recommendations: await api.listAccountRecommendations(DEFAULT_RECOMMENDATION_QUERY),
    activeJobId,
    activeJob,
  };
}

async function loadActiveRecommendationJob(
  api: ReturnType<typeof createPricingRequestApiClient>,
  activeJobId: string,
): Promise<PricingRecommendationJobStatus | null> {
  try {
    return await api.getRecommendationJob(activeJobId);
  } catch (error) {
    if (error instanceof PricingApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function selectedRecommendationIds(formData: FormData) {
  return formData
    .getAll("recommendationId")
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
}

const recommendationJobDestination = (jobId: string) => `/account/repricing?jobId=${encodeURIComponent(jobId)}`;

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    "refresh-recommendations": async ({ request }) => {
      const job = await createPricingRequestApiClient(request).refreshRecommendations();
      return formActionRedirect(null, recommendationJobDestination(job.jobId));
    },
    "apply-recommendations": async ({ request, formData }) => {
      const job = await createPricingRequestApiClient(request).applyRecommendations(
        selectedRecommendationIds(formData),
      );
      return formActionRedirect(null, recommendationJobDestination(job.jobId));
    },
    "dismiss-recommendations": async ({ request, formData }) => {
      const job = await createPricingRequestApiClient(request).dismissRecommendations(
        selectedRecommendationIds(formData),
      );
      return formActionRedirect(null, recommendationJobDestination(job.jobId));
    },
  },
  onUnknownIntent: () => ({ error: t("pricing.routes.marketplace.accountRepricing.unknown.action") }),
  onError: (error) => ({
    error: error instanceof Error ? error.message : t("pricing.routes.marketplace.accountRepricing.action.failed"),
  }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountRepricing.repricing.marketplace"),
    description: t("pricing.routes.marketplace.accountRepricing.review.seller.pricing.recommendations"),
  });

export default function MarketplaceRepricingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { message?: string; error?: string } | undefined;

  return (
    <PricingRecommendationListPage
      recommendations={data.recommendations.items}
      activeJobId={data.activeJobId}
      initialActiveJob={data.activeJob}
      message={actionData && "message" in actionData ? String(actionData.message ?? "") : null}
      errorMessage={actionData && "error" in actionData ? String(actionData.error ?? "") : null}
    />
  );
}
