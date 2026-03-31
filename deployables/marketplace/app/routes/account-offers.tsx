import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  MarketplaceBuyerOfferListPage,
  type MarketplaceOfferListItem,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "offers.view");
  const api = createMarketplaceServerApiClient(request);

  return {
    offers: await api.listBuyerOffers(DEFAULT_OFFER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Offers | Marketplace" });

export default function MarketplaceAccountOffersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceBuyerOfferListPage
      data={data.offers as ListResponse<MarketplaceOfferListItem>}
    />
  );
}
