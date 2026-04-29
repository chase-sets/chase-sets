import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type BuyerOfferMatchListItem,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "../support/request-support/api-client";
import { MarketplaceBuyerOfferMatchListPage } from "../features/offers/ui/seller-offer-list-page";

const DEFAULT_OFFER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Review buyer offer matches against your seller inventory.";

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
    buyerOfferMatches: await api.listBuyerOfferMatches(DEFAULT_OFFER_QUERY),
    sellList: await api.getBuyerOfferMatchSellList(),
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
      await api.acceptBuyerOfferMatchSellList();
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
    title: "Buyer Offer Matches | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountBuyerOfferMatchesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <MarketplaceBuyerOfferMatchListPage
      data={data.buyerOfferMatches as ListResponse<BuyerOfferMatchListItem>}
      cartData={data.sellList as ListResponse<BuyerOfferMatchListItem>}
      errorMessage={actionData?.error ?? null}
    />
  );
}
