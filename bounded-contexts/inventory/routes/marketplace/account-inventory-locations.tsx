import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { type ListResponse } from "@chase-sets/http/responses";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { InventoryApiError, type InventoryStorageLocation } from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { StorageLocationPage } from "../../features/storage-locations/ui/storage-location-page";

function shipFromAddressFromForm(formData: FormData) {
  return {
    name: String(formData.get("shipFromName") ?? ""),
    company: String(formData.get("shipFromCompany") ?? "").trim() || null,
    line1: String(formData.get("shipFromLine1") ?? ""),
    line2: String(formData.get("shipFromLine2") ?? "").trim() || null,
    city: String(formData.get("shipFromCity") ?? ""),
    state: String(formData.get("shipFromState") ?? ""),
    postalCode: String(formData.get("shipFromPostalCode") ?? ""),
    country: String(formData.get("shipFromCountry") ?? "US") || "US",
    phone: String(formData.get("shipFromPhone") ?? "").trim() || null,
    email: String(formData.get("shipFromEmail") ?? "").trim() || null,
  };
}

function inventoryApiErrorStatus(error: unknown) {
  return error instanceof InventoryApiError ? error.status : null;
}

function inventoryApiErrorBody(error: unknown) {
  return error instanceof InventoryApiError ? error.body : null;
}

function inventoryApiErrorCode(error: unknown) {
  const body = inventoryApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);
  const locationsRead = await loadAfterWrite({
    request,
    load: () => api.listStorageLocations("includeArchived=true"),
    isNotFound: (error) => inventoryApiErrorStatus(error) === 404,
    getStatus: inventoryApiErrorStatus,
    getErrorCode: inventoryApiErrorCode,
    getBody: inventoryApiErrorBody,
  });

  if (locationsRead.kind === "data") {
    return {
      locations: locationsRead.data,
      loadError: null,
    };
  }

  if (locationsRead.kind === "pending") {
    return {
      locations: { items: [], total: 0, count: 0 } satisfies ListResponse<InventoryStorageLocation>,
      loadError: "Storage locations are still updating. Reload this page in a moment.",
    };
  }

  if (locationsRead.reason !== "fresh-write-read-permanent") {
    throw new Response("Storage location update could not be verified. Reload this page and try again.", {
      status: 409,
    });
  }

  throw locationsRead.error;
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createInventoryRequestApiClient(request);

  try {
    let result: unknown = null;
    switch (intent) {
      case "create-location":
        result = await api.createStorageLocation({
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          shipFromAddress: shipFromAddressFromForm(formData),
        });
        break;
      case "update-location":
        result = await api.updateStorageLocation(String(formData.get("storageLocationId") ?? ""), {
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          shipFromAddress: shipFromAddressFromForm(formData),
          isArchived: false,
        });
        break;
      case "archive-location":
        result = await api.updateStorageLocation(String(formData.get("storageLocationId") ?? ""), {
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          shipFromAddress: shipFromAddressFromForm(formData),
          isArchived: true,
        });
        break;
      default:
        break;
    }

    return redirect(navigateAfterWrite(result, "/account/inventory/locations"));
  } catch (error) {
    if (error instanceof InventoryApiError) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("inventory.routes.marketplace.accountInventoryLocations.inventory.locations.marketplace"),
    description: t("inventory.routes.marketplace.accountInventoryLocations.manage.the.storage.locations.and.ship"),
  });

export default function MarketplaceInventoryLocationsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <StorageLocationPage
      locations={(data.locations as ListResponse<InventoryStorageLocation>).items}
      errorMessage={actionData?.error ?? data.loadError ?? null}
    />
  );
}
