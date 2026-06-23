import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import { readApiErrorCode } from "@chase-sets/http/responses";
import { loadAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createInventoryRequestApiClient,
  InventoryApiError,
  type InventoryImportBatchDetail,
} from "../../support/request-support/api-client";
import { InventoryImportBatchPage } from "../../features/import-batches/ui/import-batch-page";

const DEFAULT_IMPORT_QUERY = "limit=25&offset=0";
const IMPORT_BATCH_UPDATING_MESSAGE = t(
  "inventory.routes.marketplace.accountInventoryImports.import.batch.still.updating",
);

function requestWithoutFreshWrite(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  url.searchParams.delete("postWriteHandoff");

  return new Request(url.toString(), {
    headers: request.headers,
    method: request.method,
  });
}

function inventoryApiErrorStatus(error: unknown) {
  return error instanceof InventoryApiError ? error.status : null;
}

function inventoryApiErrorBody(error: unknown) {
  return error instanceof InventoryApiError ? error.body : null;
}

function inventoryApiErrorCode(error: unknown) {
  return readApiErrorCode(inventoryApiErrorBody(error));
}

async function loadImportBatchDetail(
  request: Request,
  load: () => Promise<InventoryImportBatchDetail>,
): Promise<Readonly<{ detail: InventoryImportBatchDetail | null; detailLoadMessage: string | null }>> {
  const detailRead = await loadAfterWrite({
    request,
    isNotFound: (error) => inventoryApiErrorStatus(error) === 404,
    getStatus: inventoryApiErrorStatus,
    getErrorCode: inventoryApiErrorCode,
    getBody: inventoryApiErrorBody,
    load,
  });

  if (detailRead.kind === "data") {
    return {
      detail: detailRead.data,
      detailLoadMessage: null,
    };
  }

  if (detailRead.kind === "pending") {
    return {
      detail: null,
      detailLoadMessage: IMPORT_BATCH_UPDATING_MESSAGE,
    };
  }

  if (detailRead.reason !== "fresh-write-read-permanent") {
    throw new Response("Import batch update could not be verified. Reload this page and try again.", {
      status: 409,
    });
  }

  if (inventoryApiErrorStatus(detailRead.error) === 404) {
    throw new Response(t("inventory.features.importBatches.api.route.import.batch.not.found"), { status: 404 });
  }

  throw detailRead.error;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);
  const nonFreshApi = createInventoryRequestApiClient(requestWithoutFreshWrite(request));
  const batchId = params.batchId;
  const detailResult = batchId
    ? await loadImportBatchDetail(request, () => api.getImportBatch(batchId))
    : { detail: null, detailLoadMessage: null };

  return {
    batches: await nonFreshApi.listImportBatches(DEFAULT_IMPORT_QUERY),
    storageLocations: await nonFreshApi.listStorageLocations("limit=100&offset=0"),
    activeJobId: new URL(request.url).searchParams.get("jobId") ?? "",
    detail: detailResult.detail,
    detailLoadMessage: detailResult.detailLoadMessage,
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
      const uploadedFile = formData.get("file");
      const file = uploadedFile instanceof File && uploadedFile.size > 0 ? uploadedFile : null;
      const job = await api.createImportBatch({
        csvText: file ? await file.text() : String(formData.get("csvText") ?? ""),
        sourceKey: String(formData.get("sourceKey") ?? "native-csv"),
        quantityMode: String(formData.get("quantityMode") ?? "add"),
        defaultStorageLocationId: String(formData.get("defaultStorageLocationId") ?? "").trim() || null,
        sourceFilename: (file?.name ?? String(formData.get("sourceFilename") ?? "").trim()) || null,
      });
      return redirect(`/account/inventory/imports?jobId=${encodeURIComponent(job.jobId)}`);
    }

    if (intent === "commit-batch") {
      const batchId = String(formData.get("batchId") ?? "");
      const job = await api.commitImportBatch(batchId);
      return redirect(`/account/inventory/imports/${batchId}?jobId=${encodeURIComponent(job.jobId)}`);
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
  const location = useLocation();

  return (
    <InventoryImportBatchPage
      batches={data.batches.items}
      storageLocations={data.storageLocations.items}
      detail={data.detail}
      detailLoadMessage={data.detailLoadMessage}
      activeJobId={data.activeJobId}
      currentPath={`${location.pathname}${location.search}`}
      errorMessage={actionData?.error ?? null}
    />
  );
}
