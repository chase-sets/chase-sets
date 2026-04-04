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
  MarketplaceListingDetailPage,
  type MarketplaceListingDetail,
} from "../web";

const MARKETPLACE_DESCRIPTION =
  "Inspect listing inventory, pricing, quantity caps, and publication status.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromIdentityApi({ request, permission: "listings.view" });
  const api = createMarketplaceRequestApiClient(request);

  try {
    return {
      listing: await api.getSellerListing(params.listingId!),
    };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      throw new Response("Listing not found.", { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromIdentityApi({ request, permission: "listings.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);

  try {
    switch (intent) {
      case "update-price":
        await api.updateListingPrice(params.listingId!, {
          priceAmount: formData.get("priceAmount"),
        });
        break;
      case "update-quantity-cap":
        await api.updateListingQuantityCap(params.listingId!, {
          quantityCap: Number(formData.get("quantityCap") ?? 0),
        });
        break;
      case "publish":
        await api.publishListing(params.listingId!);
        break;
      case "pause":
        await api.pauseListing(params.listingId!);
        break;
      case "withdraw":
        await api.withdrawListing(params.listingId!);
        break;
      default:
        break;
    }

    return redirect(new URL(request.url).pathname);
  } catch (error) {
    if (error instanceof MarketplaceApiError) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Listing | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountListingRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <MarketplaceListingDetailPage
      listing={data.listing as MarketplaceListingDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
