import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useLocation } from "react-router";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import { createInventoryRequestApiClient, type InventoryItemDetail } from "../../support/request-support/api-client";
import { inventoryApiErrorAdapter } from "../../support/request-support/route-api-error";
import { InventoryItemDetailPage } from "../../features/inventory-items/ui/inventory-item-detail-page";

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-inventory-item",
  authorization: { permission: "inventory.view" },
  errorAdapter: inventoryApiErrorAdapter,
  load: ({ request, params }) => createInventoryRequestApiClient(request).getItem(params.itemId!),
  map: (item) => ({ item }),
  messages: {
    pending: "Inventory item is still updating. Reload this page in a moment.",
    unverified: "Inventory item update could not be verified. Reload this page and try again.",
    notFound: t("inventory.routes.marketplace.accountInventoryItem.inventory.item.not.found"),
  },
});

export const action = defineFormAction({
  authorization: { permission: "inventory.manage" },
  errorAdapter: inventoryApiErrorAdapter,
  intents: {
    "adjust-item": async ({ request, params, formData }) => {
      const result = await createInventoryRequestApiClient(request).adjustItem(params.itemId!, {
        quantityDelta: Number(formData.get("quantityDelta") ?? 0),
        reason: formData.get("reason"),
      });
      if (result && typeof result === "object" && "status" in result && result.status === "hold-collision-recorded") {
        return { message: "message" in result ? String(result.message ?? "") : "" };
      }
      return formActionRedirect(result, new URL(request.url).pathname);
    },
    "create-hold": async ({ request, params, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).createHold(params.itemId!, {
          quantity: Number(formData.get("quantity") ?? 0),
          reason: formData.get("reason"),
          notes: String(formData.get("notes") ?? "").trim() || null,
        }),
        new URL(request.url).pathname,
      ),
    "release-hold": async ({ request, formData }) =>
      formActionRedirect(
        await createInventoryRequestApiClient(request).releaseHold(String(formData.get("holdId") ?? "")),
        new URL(request.url).pathname,
      ),
  },
  onUnknownIntent: ({ request }) =>
    new Response(null, { status: 302, headers: { Location: new URL(request.url).pathname } }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("inventory.routes.marketplace.accountInventoryItem.inventory.item.marketplace"),
    description: t("inventory.routes.marketplace.accountInventoryItem.inspect.a.specific.inventory.item.its"),
  });

export default function MarketplaceInventoryItemRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; message?: string } | undefined;
  const location = useLocation();

  return (
    <InventoryItemDetailPage
      item={data.item as InventoryItemDetail}
      currentPath={`${location.pathname}${location.search}`}
      errorMessage={actionData?.error ?? actionData?.message ?? null}
    />
  );
}
