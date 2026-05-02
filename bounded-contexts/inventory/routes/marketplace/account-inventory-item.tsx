import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  InventoryApiError,
  type InventoryItemDetail,
} from "../../support/request-support/api-client";
import { createInventoryRequestApiClient } from "../../support/request-support/api-client";
import { InventoryItemDetailPage } from "../../features/inventory-items/ui/inventory-item-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);

  try {
    return {
      item: await api.getItem(params.itemId!),
    };
  } catch (error) {
    if (error instanceof InventoryApiError && error.status === 404) {
      throw new Response(t("inventory.routes.marketplace.accountInventoryItem.inventory.item.not.found"), { status: 404 });
    }

    throw error;
  }
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
        await api.adjustItem(params.itemId!, {
          quantityDelta: Number(formData.get("quantityDelta") ?? 0),
          reason: formData.get("reason"),
        });
        break;
      case "create-hold":
        await api.createHold(params.itemId!, {
          quantity: Number(formData.get("quantity") ?? 0),
          reason: formData.get("reason"),
          notes: String(formData.get("notes") ?? "").trim() || null,
        });
        break;
      case "release-hold":
        await api.releaseHold(String(formData.get("holdId") ?? ""));
        break;
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

  return (
    <InventoryItemDetailPage
      item={data.item as InventoryItemDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
