import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  ApiError as MarketplaceApiError,
  MarketplaceSellerOfferDetailPage,
  type MarketplaceSellerOfferDetail,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "offers.view");
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceServerApiClient(request);

  try {
    return {
      offer: await api.getSellerOffer(params.offerId!),
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response("Offer not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Market Offer | Marketplace" });

export default function MarketplaceAccountMarketOfferRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceSellerOfferDetailPage
      offer={data.offer as MarketplaceSellerOfferDetail}
    />
  );
}
