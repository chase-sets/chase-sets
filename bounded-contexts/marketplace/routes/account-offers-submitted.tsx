import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type SubmittedBuyerOfferListItem,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceSubmittedBuyerOfferListPage } from "../features/offers/ui/buyer-offer-list-page";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Track buyer offers you have submitted against marketplace inventory.";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  return {
    submittedBuyerOffers: await api.listSubmittedBuyerOffers(DEFAULT_OFFER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Submitted Buyer Offers | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedBuyerOffersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceSubmittedBuyerOfferListPage
      data={data.submittedBuyerOffers as ListResponse<SubmittedBuyerOfferListItem>}
    />
  );
}
