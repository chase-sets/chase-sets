import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "@chase-sets/identity/server";
import {
  MarketplaceApiError,
  createMarketplaceRequestApiClient,
} from "@chase-sets/marketplace/client";
import {
  OrderingApiError,
  createOrderingRequestApiClient,
} from "@chase-sets/ordering/client";
import {
  MarketplaceOfferSubmissionSection,
} from "@chase-sets/marketplace/web";
import { OrderingAddToCartSection } from "@chase-sets/ordering/web";
import { DiscoveryApiError, createDiscoveryRequestApiClient } from "../client";
import { ItemDetailPage } from "../web";

const MARKETPLACE_DESCRIPTION =
  "Browse the Chase Sets marketplace with server-rendered discovery results and item detail pages.";

function parseVersionSelection(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));

    return Array.isArray(parsed)
      ? parsed
          .filter(
            (selection): selection is { dimensionId: string; choiceId: string } =>
              Boolean(
                selection &&
                typeof selection === "object" &&
                "dimensionId" in selection &&
                "choiceId" in selection,
              ),
          )
          .map((selection) => ({
            dimensionId: String(selection.dimensionId ?? ""),
            choiceId: String(selection.choiceId ?? ""),
          }))
      : [];
  } catch {
    return [];
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createDiscoveryRequestApiClient(request);
  const id = params.id;

  if (!id) {
    return {
      item: null,
      notFound: true,
    };
  }

  try {
    const item = await api.getItemDetail(id);
    return {
      item,
      notFound: false,
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return {
        item: null,
        notFound: true,
        error: error.message,
      };
    }

    return {
      item: null,
      notFound: true,
      error: error instanceof Error ? error.message : "Item not found.",
    };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createDiscoveryRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const orderingApi = createOrderingRequestApiClient(request);

  try {
    if (intent === "submit-offer") {
      await requireActorFromIdentityApi({
        request,
        permission: "offers.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await marketplaceApi.createBuyerOffer({
        catalogItemId: item.item_id,
        catalogVersionKey: String(formData.get("catalogVersionKey") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        versionSelection: parseVersionSelection(formData.get("versionSelection")),
        versionSummary: String(formData.get("versionSummary") ?? "") || null,
        priceAmount: formData.get("priceAmount"),
        quantityRequested: Number(formData.get("quantityRequested") ?? 0),
      });

      return redirect("/account/offers");
    }

    if (intent === "add-to-cart") {
      await requireActorFromIdentityApi({
        request,
        permission: "orders.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await orderingApi.addCartLine({
        catalogItemId: item.item_id,
        catalogVersionKey: String(formData.get("catalogVersionKey") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        versionSelection: parseVersionSelection(formData.get("versionSelection")),
        versionSummary: String(formData.get("versionSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
      });

      return redirect("/account/cart");
    }

    return null;
  } catch (error) {
    if (error instanceof MarketplaceApiError || error instanceof OrderingApiError) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  buildOpenGraphMeta({
    title: data?.item
      ? `${data.item.title} | Marketplace`
      : "Item Not Found | Marketplace",
    description: data?.item?.description
      ? data.item.description
      : MARKETPLACE_DESCRIPTION,
    imageUrl: data?.item?.image_urls[0],
    type: data?.item ? "product" : "website",
  });

export default function DiscoveryItemDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <ItemDetailPage
      data={data.item}
      notFound={data.notFound}
      error={data.error}
      renderAfterListings={
        data.item
          ? (context) => (
              <>
                <OrderingAddToCartSection
                  catalogItemId={context.itemId}
                  catalogVersionKey={context.selectedCatalogVersionKey}
                  itemTitle={context.itemTitle}
                  versionSelection={context.selectedVersionSelection}
                  versionSummary={context.selectedVersionSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
                <MarketplaceOfferSubmissionSection
                  catalogItemId={context.itemId}
                  catalogVersionKey={context.selectedCatalogVersionKey}
                  itemTitle={context.itemTitle}
                  versionSelection={context.selectedVersionSelection}
                  versionSummary={context.selectedVersionSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
              </>
            )
          : undefined
      }
    />
  );
}
