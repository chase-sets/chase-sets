import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  Button,
  Card,
  NumberInput,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";

const MARKETPLACE_DESCRIPTION =
  "Browse the Chase Sets marketplace with server-rendered discovery results and item detail pages.";

const EMPTY_ITEM_DETAIL_RESULT = {
  item: null,
  notFound: false,
  error: null,
} as const;

function parseSelectedOptions(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));

    return Array.isArray(parsed)
      ? parsed
          .filter(
            (selection): selection is { dimensionId: string; optionId: string } =>
              Boolean(
                selection &&
                typeof selection === "object" &&
                "dimensionId" in selection &&
                "optionId" in selection,
              ),
          )
          .map((selection) => ({
            dimensionId: String(selection.dimensionId ?? ""),
            optionId: String(selection.optionId ?? ""),
          }))
      : [];
  } catch {
    return [];
  }
}

function MarketplaceOfferSubmissionSection({
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <PageSection title="Make An Offer">
      <Card>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="submit-offer" />
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input type="hidden" name="productId" value={productId} />
            <input
              type="hidden"
              name="selectedOptions"
              value={JSON.stringify(selectedOptions)}
            />
            <input type="hidden" name="productSummary" value={productSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {productSummary ?? "Standard product"}
              </Text>
              <Text size="sm" tone="secondary">
                Matching visible listings for this product: {visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                Offers are marketplace-wide in v1. They are not sent to a single seller.
              </Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <TextInput
              label="Offer price"
              name="priceAmount"
              placeholder="24.99"
              inputMode="decimal"
              required
            />
            <NumberInput label="Quantity requested" name="quantityRequested" min="1" required />
            <Button type="submit">Submit offer</Button>
          </Stack>
        </form>
      </Card>
    </PageSection>
  );
}

function OrderingAddToCartSection({
  catalogItemId,
  productId,
  itemTitle,
  selectedOptions,
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <PageSection title="Add To Cart">
      <Card>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="add-to-cart" />
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input type="hidden" name="productId" value={productId} />
            <input
              type="hidden"
              name="selectedOptions"
              value={JSON.stringify(selectedOptions)}
            />
            <input type="hidden" name="productSummary" value={productSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {productSummary ?? "Standard product"}
              </Text>
              <Text size="sm" tone="secondary">
                Matching visible listings right now: {visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                Cart lines capture buyer intent. Exact listing and inventory matching happens at checkout.
              </Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <NumberInput
              label="Quantity"
              name="quantity"
              min="1"
              defaultValue="1"
              required
            />
            <Button type="submit">Add to cart</Button>
          </Stack>
        </form>
      </Card>
    </PageSection>
  );
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
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await marketplaceApi.createBuyerOffer({
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        priceAmount: formData.get("priceAmount"),
        quantityRequested: Number(formData.get("quantityRequested") ?? 0),
      });

      return redirect("/account/offers");
    }

    if (intent === "add-to-cart") {
      await requireActorFromAuthApi({
        request,
        permission: "orders.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      await orderingApi.addCartLine({
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
      });

      return redirect("/account/cart");
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
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
  const data = useLoaderData<typeof loader>() ?? EMPTY_ITEM_DETAIL_RESULT;
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
                  productId={context.selectedProductId}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedVersionSelection}
                  productSummary={context.selectedVersionSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionData?.error ?? null}
                />
                <MarketplaceOfferSubmissionSection
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedVersionSelection}
                  productSummary={context.selectedVersionSummary}
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
