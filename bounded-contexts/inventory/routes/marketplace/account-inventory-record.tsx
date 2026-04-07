import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime/web";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  InventoryApiError,
  type InventoryRecordDetail,
} from "../../request-support/api-client";
import { createInventoryRequestApiClient } from "../../request-support/api-client";
import { InventoryRecordDetailPage } from "../../records/ui/inventory-record-detail-page";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);

  try {
    return {
      record: await api.getRecord(params.recordId!),
    };
  } catch (error) {
    if (error instanceof InventoryApiError && error.status === 404) {
      throw new Response("Inventory record not found.", { status: 404 });
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
      case "adjust-record":
        await api.adjustRecord(params.recordId!, {
          quantityDelta: Number(formData.get("quantityDelta") ?? 0),
          reason: formData.get("reason"),
        });
        break;
      case "create-hold":
        await api.createHold(params.recordId!, {
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
    title: "Inventory Record | Marketplace",
    description: "Inspect a specific inventory record, its quantities, and any active holds.",
  });

export default function MarketplaceInventoryRecordRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <InventoryRecordDetailPage
      record={data.record as InventoryRecordDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
