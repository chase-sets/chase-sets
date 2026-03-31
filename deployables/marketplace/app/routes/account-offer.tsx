import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  ApiError as MarketplaceApiError,
  MarketplaceBuyerOfferDetailPage,
  type MarketplaceBuyerOfferDetail,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "offers.view");
  const api = createMarketplaceServerApiClient(request);

  try {
    return {
      offer: await api.getBuyerOffer(params.offerId!),
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response("Offer not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Offer | Marketplace" });

export default function MarketplaceAccountOfferRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceBuyerOfferDetailPage
      offer={data.offer as MarketplaceBuyerOfferDetail}
    />
  );
}
