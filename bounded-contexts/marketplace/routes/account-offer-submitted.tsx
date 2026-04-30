import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  MarketplaceApiError,
  type SubmittedBuyerOfferDetail,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceSubmittedBuyerOfferDetailPage } from "../features/offers/ui/buyer-offer-detail-page";

const MARKETPLACE_DESCRIPTION =
  "Review pricing, demand, and status for one submitted buyer offer.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  try {
    return {
      submittedBuyerOffer: await api.getSubmittedBuyerOffer(params.offerId!),
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response("Submitted buyer offer not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Submitted Buyer Offer | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedBuyerOfferRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceSubmittedBuyerOfferDetailPage
      offer={data.submittedBuyerOffer as SubmittedBuyerOfferDetail}
    />
  );
}
