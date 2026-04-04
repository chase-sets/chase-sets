import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  MarketplaceApiError,
  createMarketplaceRequestApiClient,
} from "../client";
import {
  MarketplaceBuyerOfferDetailPage,
  type MarketplaceBuyerOfferDetail,
} from "../web";

const MARKETPLACE_DESCRIPTION =
  "Review pricing, demand, and status for one buyer offer.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

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
  buildOpenGraphMeta({
    title: "Offer | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountOfferRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceBuyerOfferDetailPage
      offer={data.offer as MarketplaceBuyerOfferDetail}
    />
  );
}
