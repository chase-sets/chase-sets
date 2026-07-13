import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { InventoryApiError, type InventoryItemDetail } from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { InventoryItemDetailPage } from "../../features/inventory-items/ui/inventory-item-detail-page";

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);

  const itemRead = await loadAfterWrite({
    request,
    load: () => api.getItem(params.itemId!),
    isNotFound: (error) => inventoryApiErrorStatus(error) === 404,
    getStatus: inventoryApiErrorStatus,
    getErrorCode: inventoryApiErrorCode,
    getBody: inventoryApiErrorBody,
  });

  if (itemRead.kind === "data") {
    return {
      item: itemRead.data,
    };
  }

  if (itemRead.kind === "pending") {
    throw new Response("Inventory item is still updating. Reload this page in a moment.", {
      status: 503,
    });
  }

  if (itemRead.reason !== "fresh-write-read-permanent") {
    throw new Response("Inventory item update could not be verified. Reload this page and try again.", {
      status: 409,
    });
  }

  if (inventoryApiErrorStatus(itemRead.error) === 404) {
    throw new Response(t("inventory.routes.marketplace.accountInventoryItem.inventory.item.not.found"), {
      status: 404,
    });
  }

  throw itemRead.error;
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createInventoryRequestApiClient(request);

  try {
    switch (intent) {
      case "adjust-item":
        return redirect(
          navigateAfterWrite(
            await api.adjustItem(params.itemId!, {
              quantityDelta: Number(formData.get("quantityDelta") ?? 0),
              reason: formData.get("reason"),
            }),
            new URL(request.url).pathname,
          ),
        );
      case "create-hold":
        return redirect(
          navigateAfterWrite(
            await api.createHold(params.itemId!, {
              quantity: Number(formData.get("quantity") ?? 0),
              reason: formData.get("reason"),
              notes: String(formData.get("notes") ?? "").trim() || null,
            }),
            new URL(request.url).pathname,
          ),
        );
      case "release-hold":
        return redirect(
          navigateAfterWrite(
            await api.releaseHold(String(formData.get("holdId") ?? "")),
            new URL(request.url).pathname,
          ),
        );
      default:
        break;
    }

    return redirect(new URL(request.url).pathname);
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
    title: t("inventory.routes.marketplace.accountInventoryItem.inventory.item.marketplace"),
    description: t("inventory.routes.marketplace.accountInventoryItem.inspect.a.specific.inventory.item.its"),
  });

export default function MarketplaceInventoryItemRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();

  return (
    <InventoryItemDetailPage
      item={data.item as InventoryItemDetail}
      currentPath={`${location.pathname}${location.search}`}
      errorMessage={actionData?.error ?? null}
    />
  );
}
