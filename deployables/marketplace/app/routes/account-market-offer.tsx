import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  ApiError as MarketplaceApiError,
  MarketplaceSellerOfferDetailPage,
  type MarketplaceSellerOfferDetail,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "offers.view");
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceServerApiClient(request);

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
  const actor = await requireMarketplaceActor(request, "offers.manage");
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceServerApiClient(request);

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
  buildMarketplaceMeta({ title: "Market Offer | Marketplace" });

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
