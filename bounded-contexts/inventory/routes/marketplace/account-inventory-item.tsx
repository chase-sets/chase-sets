import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { getMutationResultCommandReceipt, navigateAfterWrite } from "@chase-sets/http/responses";
import { useActionData, useLoaderData, useLocation, useNavigate } from "react-router";
import { useEffect, useRef } from "react";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import { createInventoryRequestApiClient, type InventoryItemDetail } from "../../support/request-support/api-client";
import { inventoryApiErrorAdapter } from "../../support/request-support/route-api-error";
import { InventoryItemDetailPage } from "../../features/inventory-items/ui/inventory-item-detail-page";
import { createOfflineSaleFormToken, submitOfflineSaleForm } from "../../features/inventory-items/ui/offline-sale-form";
import type { InventoryOfflineSaleResult } from "../../client";

type OfflineSaleActionData = Readonly<{
  offlineSale: InventoryOfflineSaleResult;
  commandReceipt: ReturnType<typeof getMutationResultCommandReceipt>;
}>;

function isOfflineSaleActionData(value: unknown): value is OfflineSaleActionData {
  return typeof value === "object" && value !== null && "offlineSale" in value && "commandReceipt" in value;
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-inventory-item",
  authorization: { permission: "inventory.view" },
  errorAdapter: inventoryApiErrorAdapter,
  load: ({ request, params }) => createInventoryRequestApiClient(request).getItem(params.itemId!),
  map: (item, { actor }) => ({
    item,
    canRecordOfflineSale: actor?.permissions.includes("inventory.manage") ?? false,
    canHonorOffline: actor?.roleKey === "owner" || actor?.roleKey === "manager",
    offlineSaleFormToken: createOfflineSaleFormToken(),
  }),
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
        reasonCode: formData.get("reasonCode"),
        note: String(formData.get("note") ?? "").trim() || null,
      });
      if (result && typeof result === "object" && "status" in result && result.status === "hold-collision-recorded") {
        return { message: "message" in result ? String(result.message ?? "") : "" };
      }
      return formActionRedirect(result, new URL(request.url).pathname);
    },
    // #7317 keeps the form boundary shared while each marketplace route owns its intent.
    "record-offline-sale": async ({ request, params, formData }) => {
      const offlineSale = await submitOfflineSaleForm(
        createInventoryRequestApiClient(request),
        params.itemId!,
        formData,
      );
      const commandReceipt = getMutationResultCommandReceipt(offlineSale);
      return commandReceipt
        ? { offlineSale, commandReceipt }
        : { error: t("inventory.features.inventoryItems.ui.offlineSaleForm.result.unverified") };
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
  const actionData = useActionData<typeof action>() as
    | { error?: string; message?: string }
    | OfflineSaleActionData
    | undefined;
  const location = useLocation();
  const navigate = useNavigate();
  const handledReceipt = useRef<string | null>(null);
  const offlineSaleAction = isOfflineSaleActionData(actionData) ? actionData : null;
  const currentPath = `${location.pathname}${location.search}`;
  const stateResult = (location.state as { offlineSaleResult?: InventoryOfflineSaleResult } | null)?.offlineSaleResult;

  useEffect(() => {
    if (!offlineSaleAction?.commandReceipt) {
      return;
    }

    const receiptKey = JSON.stringify(offlineSaleAction.commandReceipt);
    if (handledReceipt.current === receiptKey) {
      return;
    }
    handledReceipt.current = receiptKey;
    navigate(navigateAfterWrite(offlineSaleAction, currentPath), {
      replace: true,
      state: { offlineSaleResult: offlineSaleAction.offlineSale },
    });
  }, [currentPath, navigate, offlineSaleAction]);

  return (
    <InventoryItemDetailPage
      item={data.item as InventoryItemDetail}
      currentPath={currentPath}
      canRecordOfflineSale={data.canRecordOfflineSale}
      canHonorOffline={data.canHonorOffline}
      offlineSaleFormToken={data.offlineSaleFormToken}
      offlineSaleResult={stateResult ?? null}
      errorMessage={
        actionData && "error" in actionData
          ? actionData.error
          : actionData && "message" in actionData
            ? actionData.message
            : null
      }
    />
  );
}
