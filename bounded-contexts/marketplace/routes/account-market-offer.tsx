import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "@chase-sets/identity/server";
import { MarketplaceApiError, createMarketplaceRequestApiClient } from "../client";
import {
  MarketplaceSellerOfferDetailPage,
  type MarketplaceSellerOfferDetail,
} from "../web";

const MARKETPLACE_DESCRIPTION =
  "Inspect and accept an incoming market offer.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "offers.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceRequestApiClient(request);

  try {
    return {
      offer: await api.getSellerOffer(params.offerId!),
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response("Offer not found.", { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
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
    if (intent === "accept-offer") {
      await api.acceptSellerOffer(params.offerId!);
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
    title: "Market Offer | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountMarketOfferRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <MarketplaceSellerOfferDetailPage
      offer={data.offer as MarketplaceSellerOfferDetail}
      canAccept
      errorMessage={actionData?.error ?? null}
    />
  );
}
