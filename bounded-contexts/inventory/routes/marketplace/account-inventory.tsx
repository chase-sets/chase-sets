import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import { type ListResponse } from "@chase-sets/http/responses";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  InventoryApiError,
  type InventoryItemListItem,
  type InventoryStorageLocation,
} from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { InventoryItemListPage } from "../../features/inventory-items/ui/inventory-item-list-page";
import { inventoryItemPageQuery } from "../../support/request-support/list-pagination";
import { inventoryApiErrorAdapter } from "../../support/request-support/route-api-error";

const ACCOUNT_INVENTORY_READ_TIMEOUT_MS = 10_000;
const TEMPORARY_INVENTORY_ITEMS_LOAD_ERROR =
  "Inventory items are taking longer than expected. Reload this page in a moment.";
const TEMPORARY_STORAGE_LOCATIONS_LOAD_ERROR =
  "Storage locations are taking longer than expected. Reload this page in a moment.";

function parseSelectedOptionsParam(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => ({
        dimensionId: String(entry?.dimensionId ?? "").trim(),
        optionId: String(entry?.optionId ?? "").trim(),
      }))
      .filter((entry) => entry.dimensionId && entry.optionId);
  } catch {
    return [];
  }
}

function safeAccountReturnTo(value: FormDataEntryValue | string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }

  try {
    const url = new URL(raw, "http://localhost");
    if (url.origin !== "http://localhost" || !url.pathname.startsWith("/account/")) {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function emptyListResponse<T>(): ListResponse<T> {
  return { items: [], total: 0, count: 0 };
}

function pageBoundsFromQuery(query: string): { limit: number; offset: number } {
  const searchParams = new URLSearchParams(query);
  return {
    limit: Number(searchParams.get("limit")) || 100,
    offset: Number(searchParams.get("offset")) || 0,
  };
}

function isTemporaryInventoryReadError(error: unknown) {
  if (error instanceof InventoryApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

async function loadAccountInventoryReadModels(
  api: ReturnType<typeof createInventoryRequestApiClient>,
  itemsQuery: string,
) {
  const [itemsRead, locationsRead] = await Promise.allSettled([api.listItems(itemsQuery), api.listStorageLocations()]);
  const loadErrors: string[] = [];
  let items: ListResponse<InventoryItemListItem> & { limit: number; offset: number };
  let locations: ListResponse<InventoryStorageLocation>;
  const { limit: fallbackLimit, offset: fallbackOffset } = pageBoundsFromQuery(itemsQuery);

  if (itemsRead.status === "fulfilled") {
    items = itemsRead.value;
  } else if (isTemporaryInventoryReadError(itemsRead.reason)) {
    items = { ...emptyListResponse(), limit: fallbackLimit, offset: fallbackOffset };
    loadErrors.push(TEMPORARY_INVENTORY_ITEMS_LOAD_ERROR);
  } else {
    throw itemsRead.reason;
  }

  if (locationsRead.status === "fulfilled") {
    locations = locationsRead.value;
  } else if (isTemporaryInventoryReadError(locationsRead.reason)) {
    locations = emptyListResponse();
    loadErrors.push(TEMPORARY_STORAGE_LOCATIONS_LOAD_ERROR);
  } else {
    throw locationsRead.reason;
  }

  return {
    items,
    locations,
    loadError: loadErrors.length > 0 ? loadErrors.join(" ") : null,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request, {
    requestTimeoutMs: ACCOUNT_INVENTORY_READ_TIMEOUT_MS,
    recoverTransportErrorsAsGatewayTimeout: true,
  });
  const url = new URL(request.url);
  const readModels = await loadAccountInventoryReadModels(api, inventoryItemPageQuery(request));

  return {
    ...readModels,
    createItemDraft: {
      catalogItemId: url.searchParams.get("catalogItemId")?.trim() ?? "",
      selectedOptions: parseSelectedOptionsParam(url.searchParams.get("selectedOptions")),
      returnTo: safeAccountReturnTo(url.searchParams.get("returnTo")),
    },
  };
}

export const action = defineFormAction({
  authorization: { permission: "inventory.manage" },
  errorAdapter: inventoryApiErrorAdapter,
  intents: {
    "create-item": async ({ request, formData }) => {
      const result = (await createInventoryRequestApiClient(request).createItem({
        catalogItemId: formData.get("catalogItemId"),
        selectedOptions: formData.get("selectedOptions"),
        storageLocationId: formData.get("storageLocationId"),
        totalQuantity: Number(formData.get("totalQuantity") ?? 0),
        acquisitionCostAmount: String(formData.get("acquisitionCostAmount") ?? "").trim() || null,
      })) as { id?: string };
      if (result.id) {
        const returnTo = safeAccountReturnTo(formData.get("returnTo"));
        if (returnTo) {
          return formActionRedirect(result, returnTo);
        }
        return formActionRedirect(result, `/account/inventory/items/${encodeURIComponent(result.id)}`);
      }
      return formActionRedirect(null, "/account/inventory");
    },
  },
  onUnknownIntent: () => formActionRedirect(null, "/account/inventory"),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("inventory.routes.marketplace.accountInventory.inventory.marketplace"),
    description: t("inventory.routes.marketplace.accountInventory.manage.inventory.items.stock.counts.and"),
  });

export default function MarketplaceInventoryRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();

  const items = data.items as ListResponse<InventoryItemListItem> & { limit: number; offset: number };

  return (
    <InventoryItemListPage
      data={items}
      pagination={{ limit: items.limit, offset: items.offset, total: items.total }}
      locations={(data.locations as ListResponse<InventoryStorageLocation>).items}
      createItemDraft={data.createItemDraft}
      currentPath={`${location.pathname}${location.search}`}
      errorMessage={actionData?.error ?? data.loadError ?? null}
    />
  );
}
