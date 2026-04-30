import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  MarketplaceApiError,
  type SubmittedOfferDetail,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceSubmittedOfferDetailPage } from "../features/offers/ui/submitted-offer-detail-page";

const MARKETPLACE_DESCRIPTION =
  "Review pricing, demand, and status for one submitted offer.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "offers.view" });
  const api = createMarketplaceRequestApiClient(request);

  try {
    return {
      submittedOffer: await api.getSubmittedOffer(params.offerId!),
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response("Submitted offer not found.", { status: 404 });
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Submitted Offer | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountSubmittedOfferRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <MarketplaceSubmittedOfferDetailPage
      offer={data.submittedOffer as SubmittedOfferDetail}
    />
  );
}
