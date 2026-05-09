import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient } from "../../support/request-support/api-client";
import { PricingRecommendationListPage } from "../../features/recommendations/ui/recommendation-list-page";

const DEFAULT_RECOMMENDATION_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "pricing.view",
  });
  const api = createPricingRequestApiClient(request);

  return {
    recommendations: await api.listAccountRecommendations(DEFAULT_RECOMMENDATION_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("pricing.routes.marketplace.accountRepricing.repricing.marketplace"),
    description: t("pricing.routes.marketplace.accountRepricing.review.seller.pricing.recommendations"),
  });

export default function MarketplaceRepricingRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <PricingRecommendationListPage
      recommendations={data.recommendations.items}
    />
  );
}
