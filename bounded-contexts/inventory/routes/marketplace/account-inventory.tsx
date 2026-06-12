import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { PlatformFeedbackPrompt } from "@chase-sets/platform-operations/server";
import {
  InventoryApiError,
  type InventoryItemListItem,
  type InventoryStorageLocation,
} from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { InventoryItemListPage } from "../../features/inventory-items/ui/inventory-item-list-page";

const DEFAULT_ITEM_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);

  return {
    items: await api.listItems(DEFAULT_ITEM_QUERY),
    locations: await api.listStorageLocations(),
  };
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
    if (intent === "create-item") {
      const result = (await api.createItem({
        catalogItemId: formData.get("catalogItemId"),
        selectedOptions: formData.get("selectedOptions"),
        storageLocationId: formData.get("storageLocationId"),
        totalQuantity: Number(formData.get("totalQuantity") ?? 0),
        acquisitionCostAmount: String(formData.get("acquisitionCostAmount") ?? "").trim() || null,
      })) as { id?: string };
      const feedback = new URLSearchParams({
        feedbackWorkflow: "inventory-create",
      });
      if (result.id) {
        feedback.set("feedbackEntityId", result.id);
      }
      return redirect(`/account/inventory?${feedback}`);
    }

    return redirect("/account/inventory");
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
    title: t("inventory.routes.marketplace.accountInventory.inventory.marketplace"),
    description: t("inventory.routes.marketplace.accountInventory.manage.inventory.items.stock.counts.and"),
  });

export default function MarketplaceInventoryRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const shouldShowFeedback = searchParams.get("feedbackWorkflow") === "inventory-create";
  const feedbackEntityId = searchParams.get("feedbackEntityId");

  return (
    <InventoryItemListPage
      data={data.items as ListResponse<InventoryItemListItem>}
      locations={(data.locations as ListResponse<InventoryStorageLocation>).items}
      errorMessage={actionData?.error ?? null}
      feedbackPrompt={
        shouldShowFeedback ? (
          <PlatformFeedbackPrompt
            workflow="inventory-create"
            sourceRoutePath="/account/inventory"
            relatedEntities={feedbackEntityId ? [{ type: "inventory-item", id: feedbackEntityId }] : []}
            title={t("inventory.routes.marketplace.accountInventory.feedback.title")}
            description={t("inventory.routes.marketplace.accountInventory.feedback.description")}
          />
        ) : null
      }
    />
  );
}
