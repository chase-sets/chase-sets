import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  MarketplaceSellerOfferListPage,
  type MarketplaceSellerOfferListItem,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "offers.view");
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceServerApiClient(request);

  return {
    offers: await api.listSellerOffers(DEFAULT_OFFER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Market Offers | Marketplace" });

export default function MarketplaceAccountMarketOffersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceSellerOfferListPage
      data={data.offers as ListResponse<MarketplaceSellerOfferListItem>}
    />
  );
}
