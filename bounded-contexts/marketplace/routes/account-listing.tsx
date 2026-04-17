import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingDetail,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import { MarketplaceListingDetailPage } from "../features/listings/ui/listing-detail-page";

const MARKETPLACE_DESCRIPTION =
  "Inspect listing inventory, pricing, quantity caps, and publication status.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
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
  await requireActorFromAuthApi({ request, permission: "listings.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);
  const priceDraftAmount = String(formData.get("priceAmount") ?? "");

  try {
    switch (intent) {
      case "preview-price":
        return {
          priceDraftAmount,
          pricePreview: await api.previewListingTerms({
            priceAmount: priceDraftAmount,
          }),
        };
      case "update-price":
        await api.updateListingPrice(params.listingId!, {
          priceAmount: priceDraftAmount,
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
        priceDraftAmount,
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
      priceDraftAmount={actionData?.priceDraftAmount ?? null}
      pricePreview={actionData?.pricePreview as MarketplaceListingTermsPreview | null | undefined}
      errorMessage={actionData?.error ?? null}
    />
  );
}
