import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  type MarketplaceSellerOfferListItem,
} from "../request-support/api-client";
import { createMarketplaceRequestApiClient } from "../request-support/api-client";
import { MarketplaceSellerOfferListPage } from "../offers/ui/seller-offer-list-page";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Review incoming market offers against your seller inventory.";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceRequestApiClient(request);

  return {
    offers: await api.listSellerOffers(DEFAULT_OFFER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Market Offers | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountMarketOffersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceSellerOfferListPage
      data={data.offers as ListResponse<MarketplaceSellerOfferListItem>}
    />
  );
}
