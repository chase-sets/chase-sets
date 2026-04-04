import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { ItemDetailPage } from "@chase-sets/discovery/web";
import {
  ApiError as MarketplaceApiError,
  MarketplaceOfferSubmissionSection,
} from "@chase-sets/marketplace-context/web";
import {
  ApiError as OrderingApiError,
  OrderingAddToCartSection,
} from "@chase-sets/ordering/web";
import {
  createMarketplaceDiscoveryApiClient,
  createMarketplaceOrderingApiClient,
  createMarketplaceServerApiClient,
} from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createMarketplaceDiscoveryApiClient(request);
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
    return {
      item: null,
      notFound: true,
      error: error instanceof Error ? error.message : "Item not found.",
    };
  }
}

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

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createMarketplaceDiscoveryApiClient(request);
  const marketplaceApi = createMarketplaceServerApiClient(request);
  const orderingApi = createMarketplaceOrderingApiClient(request);

  try {
    if (intent === "submit-offer") {
      await requireMarketplaceActor(request, "offers.manage");
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
      await requireMarketplaceActor(request, "orders.manage");
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

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data?.item
    ? `${data.item.title} | Marketplace`
    : "Item Not Found | Marketplace";

  const description = data?.item?.description
    ? data.item.description
    : "View marketplace item details for Chase Sets.";

  return buildMarketplaceMeta({
    title,
    description,
    imageUrl: data?.item?.image_urls[0],
    type: data?.item ? "product" : "website",
  });
};

export default function MarketplaceItemDetailRoute() {
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
