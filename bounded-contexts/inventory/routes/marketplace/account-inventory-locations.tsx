import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { type ListResponse } from "@chase-sets/http/responses";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import { InventoryApiError, type InventoryStorageLocation } from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { StorageLocationPage } from "../../features/storage-locations/ui/storage-location-page";
import { inventoryApiErrorAdapter } from "../../support/request-support/route-api-error";

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

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-inventory-locations",
  authorization: { permission: "inventory.view" },
  errorAdapter: inventoryApiErrorAdapter,
  load: ({ request }) => createInventoryRequestApiClient(request).listStorageLocations("includeArchived=true"),
  map: (locations) => ({ locations, loadError: null }),
  onPending: () => ({
    locations: { items: [], total: 0, count: 0 } satisfies ListResponse<InventoryStorageLocation>,
    loadError: "Storage locations are still updating. Reload this page in a moment.",
  }),
  messages: { unverified: "Storage location update could not be verified. Reload this page and try again." },
});

const locationsDestination = "/account/inventory/locations";

export const action = defineFormAction({
  authorization: { permission: "inventory.manage" },
  errorAdapter: inventoryApiErrorAdapter,
  intents: {
    "create-location": async ({ request, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).createStorageLocation({
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          shipFromAddress: shipFromAddressFromForm(formData),
        }),
        locationsDestination,
      ),
    "update-location": async ({ request, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).updateStorageLocation(
          String(formData.get("storageLocationId") ?? ""),
          {
            name: formData.get("name"),
            description: String(formData.get("description") ?? "").trim() || null,
            shipFromCode: formData.get("shipFromCode"),
            shipFromAddress: shipFromAddressFromForm(formData),
            isArchived: false,
          },
        ),
        locationsDestination,
      ),
    "archive-location": async ({ request, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).updateStorageLocation(
          String(formData.get("storageLocationId") ?? ""),
          {
            name: formData.get("name"),
            description: String(formData.get("description") ?? "").trim() || null,
            shipFromCode: formData.get("shipFromCode"),
            shipFromAddress: shipFromAddressFromForm(formData),
            isArchived: true,
          },
        ),
        locationsDestination,
      ),
  },
  onUnknownIntent: () => formActionRedirect(null, locationsDestination),
});

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
