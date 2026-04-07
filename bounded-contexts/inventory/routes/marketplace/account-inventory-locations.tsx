import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime/web";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  InventoryApiError,
  type InventoryStorageLocation,
} from "../../request-support/api-client";
import { createInventoryRequestApiClient } from "../../request-support/api-client";
import { StorageLocationPage } from "../../storage-locations/ui/storage-location-page";

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
        });
        break;
      case "update-location":
        await api.updateStorageLocation(String(formData.get("storageLocationId") ?? ""), {
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
          isArchived: false,
        });
        break;
      case "archive-location":
        await api.updateStorageLocation(String(formData.get("storageLocationId") ?? ""), {
          name: formData.get("name"),
          description: String(formData.get("description") ?? "").trim() || null,
          shipFromCode: formData.get("shipFromCode"),
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
    title: "Inventory Locations | Marketplace",
    description: "Manage the storage locations and ship-from metadata used by inventory records.",
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
