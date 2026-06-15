import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../../support/request-support/api-client";
import { requirePricingAccountRepricingRollout } from "../../support/request-support/rollout-guard";
import { PricingRecommendationListPage } from "../../features/recommendations/ui/recommendation-list-page";
import type { PricingRecommendationJobStatus } from "../../features/recommendations/api/runtime";

const DEFAULT_RECOMMENDATION_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "pricing.view",
  });
  await requirePricingAccountRepricingRollout(request, actor);
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

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "pricing.manage",
  });
  await requirePricingAccountRepricingRollout(request, actor);
  const api = createPricingRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "refresh-recommendations") {
      const job = await api.refreshRecommendations();
      return redirect(`/account/repricing?jobId=${encodeURIComponent(job.jobId)}`);
    }

    if (intent === "apply-recommendations") {
      const job = await api.applyRecommendations(selectedRecommendationIds(formData));
      return redirect(`/account/repricing?jobId=${encodeURIComponent(job.jobId)}`);
    }

    if (intent === "dismiss-recommendations") {
      const job = await api.dismissRecommendations(selectedRecommendationIds(formData));
      return redirect(`/account/repricing?jobId=${encodeURIComponent(job.jobId)}`);
    }

    return {
      error: t("pricing.routes.marketplace.accountRepricing.unknown.action"),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("pricing.routes.marketplace.accountRepricing.action.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountRepricing.repricing.marketplace"),
    description: t("pricing.routes.marketplace.accountRepricing.review.seller.pricing.recommendations"),
  });

export default function MarketplaceRepricingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

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
