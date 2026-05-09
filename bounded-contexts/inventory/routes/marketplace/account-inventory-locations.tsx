import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  InventoryApiError,
  type InventoryStorageLocation,
} from "../../support/request-support/api-client";
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

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);
  return api.listStorageLocations("includeArchived=true");
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
    switch (intent) {
      case "create-location":
        await api.createStorageLocation({
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          shipFromAddress: shipFromAddressFromForm(formData),
        });
        break;
      case "update-location":
        await api.updateStorageLocation(String(formData.get("storageLocationId") ?? ""), {
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          shipFromAddress: shipFromAddressFromForm(formData),
          isArchived: false,
        });
        break;
      case "archive-location":
        await api.updateStorageLocation(String(formData.get("storageLocationId") ?? ""), {
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

    return redirect("/account/inventory/locations");
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
      locations={(data as ListResponse<InventoryStorageLocation>).items}
      errorMessage={actionData?.error ?? null}
    />
  );
}
