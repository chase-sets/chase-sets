import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  ApiError as MarketplaceApiError,
  MarketplaceListingDetailPage,
  type MarketplaceListingDetail,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "listings.view");
  const api = createMarketplaceServerApiClient(request);

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
  await requireMarketplaceActor(request, "listings.manage");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceServerApiClient(request);

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
  buildMarketplaceMeta({ title: "Listing | Marketplace" });

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
