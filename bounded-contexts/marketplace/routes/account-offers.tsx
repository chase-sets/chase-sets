import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  type MarketplaceOfferListItem,
} from "../request-support/api-client";
import { createMarketplaceRequestApiClient } from "../request-support/api-client";
import { MarketplaceBuyerOfferListPage } from "../offers/ui/buyer-offer-list-page";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Track offer requests you have submitted against marketplace inventory.";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  return {
    offers: await api.listBuyerOffers(DEFAULT_OFFER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Offers | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountOffersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceBuyerOfferListPage
      data={data.offers as ListResponse<MarketplaceOfferListItem>}
    />
  );
}
