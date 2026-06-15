import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import {
  appendFreshWriteToken,
  loadFreshlyWrittenResource,
  recoverFreshWriteReadError,
} from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { PlatformFeedbackPrompt } from "@chase-sets/platform-operations/server";
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

  try {
    return {
      item: await loadFreshlyWrittenResource({
        request,
        load: () => api.getItem(params.itemId!),
        isNotFound: (error) => inventoryApiErrorStatus(error) === 404,
      }),
    };
  } catch (error) {
    const recovery = recoverFreshWriteReadError({
      request,
      error,
      getStatus: inventoryApiErrorStatus,
      getErrorCode: inventoryApiErrorCode,
      getBody: inventoryApiErrorBody,
      recoverTransient: () =>
        new Response("Inventory item is still updating. Reload this page in a moment.", {
          status: 503,
        }),
    });
    if (recovery) {
      throw recovery;
    }

    if (inventoryApiErrorStatus(error) === 404) {
      throw new Response(t("inventory.routes.marketplace.accountInventoryItem.inventory.item.not.found"), {
        status: 404,
      });
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
        return redirect(
          appendFreshWriteToken(
            `${new URL(request.url).pathname}?feedbackWorkflow=inventory-adjust`,
            await api.adjustItem(params.itemId!, {
              quantityDelta: Number(formData.get("quantityDelta") ?? 0),
              reason: formData.get("reason"),
            }),
          ),
        );
      case "create-hold":
        return redirect(
          appendFreshWriteToken(
            new URL(request.url).pathname,
            await api.createHold(params.itemId!, {
              quantity: Number(formData.get("quantity") ?? 0),
              reason: formData.get("reason"),
              notes: String(formData.get("notes") ?? "").trim() || null,
            }),
          ),
        );
      case "release-hold":
        return redirect(
          appendFreshWriteToken(
            new URL(request.url).pathname,
            await api.releaseHold(String(formData.get("holdId") ?? "")),
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
  const [searchParams] = useSearchParams();
  const feedbackWorkflowParam = searchParams.get("feedbackWorkflow");
  const feedbackWorkflow =
    feedbackWorkflowParam === "inventory-adjust" || feedbackWorkflowParam === "inventory-create"
      ? feedbackWorkflowParam
      : null;

  return (
    <InventoryItemDetailPage
      item={data.item as InventoryItemDetail}
      errorMessage={actionData?.error ?? null}
      feedbackPrompt={
        feedbackWorkflow ? (
          <PlatformFeedbackPrompt
            workflow={feedbackWorkflow}
            sourceRoutePath={`/account/inventory/items/${data.item.item_id}`}
            relatedEntities={[{ type: "inventory-item", id: data.item.item_id }]}
            title={
              feedbackWorkflow === "inventory-create"
                ? t("inventory.routes.marketplace.accountInventory.feedback.title")
                : t("inventory.routes.marketplace.accountInventoryItem.feedback.title")
            }
            description={
              feedbackWorkflow === "inventory-create"
                ? t("inventory.routes.marketplace.accountInventory.feedback.description")
                : t("inventory.routes.marketplace.accountInventoryItem.feedback.description")
            }
          />
        ) : null
      }
    />
  );
}
