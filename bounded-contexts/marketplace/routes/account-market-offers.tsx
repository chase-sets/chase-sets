import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type MarketplaceSellerOfferListItem,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceSellerOfferListPage } from "../features/offers/ui/seller-offer-list-page";

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
    offerCart: await api.getSellerOfferCart(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "offers.manage",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);

  try {
    if (intent === "accept-sell-list") {
      await api.acceptSellerOfferCart();
      return redirect("/account/sales");
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Market Offers | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountMarketOffersRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <MarketplaceSellerOfferListPage
      data={data.offers as ListResponse<MarketplaceSellerOfferListItem>}
      cartData={data.offerCart as ListResponse<MarketplaceSellerOfferListItem>}
      errorMessage={actionData?.error ?? null}
    />
  );
}
