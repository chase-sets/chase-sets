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
  createInventoryRequestApiClient,
  InventoryApiError,
} from "../../support/request-support/api-client";
import { InventoryImportBatchPage } from "../../features/import-batches/ui/import-batch-page";

const DEFAULT_IMPORT_QUERY = "limit=25&offset=0";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);
  const batchId = params.batchId;

  return {
    batches: await api.listImportBatches(DEFAULT_IMPORT_QUERY),
    detail: batchId ? await api.getImportBatch(batchId) : null,
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
    if (intent === "create-batch") {
      const result = await api.createImportBatch({
        csvText: String(formData.get("csvText") ?? ""),
        sourceFilename: String(formData.get("sourceFilename") ?? "").trim() || null,
      });
      return redirect(`/account/inventory/imports/${result.batch_id}`);
    }

    if (intent === "commit-batch") {
      const batchId = String(formData.get("batchId") ?? "");
      await api.commitImportBatch(batchId);
      return redirect(`/account/inventory/imports/${batchId}`);
    }

    return redirect("/account/inventory/imports");
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
    title: t("inventory.routes.marketplace.accountInventoryImports.inventory.import.marketplace"),
    description: t("inventory.routes.marketplace.accountInventoryImports.upload.review.and.commit.csv"),
  });

export default function MarketplaceInventoryImportsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <InventoryImportBatchPage
      batches={data.batches.items}
      detail={data.detail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
