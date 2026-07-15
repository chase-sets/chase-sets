import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useLocation } from "react-router";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import contextManifest from "../../context.json";
import { parseSelectedOptionsInput } from "../../features/inventory-items/integrations/catalog/versioning";
import {
  createInventoryRequestApiClient,
  InventoryApiError,
  type InventoryImportBatchDetail,
} from "../../support/request-support/api-client";
import { InventoryImportBatchPage } from "../../features/import-batches/ui/import-batch-page";
import { resolveRowRedirectTarget } from "../../features/import-batches/ui/resolution-flow";
import { inventoryApiErrorAdapter } from "../../support/request-support/route-api-error";

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

const loadImportBatchDetail = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-inventory-import",
  authorization: { permission: "inventory.view" },
  errorAdapter: inventoryApiErrorAdapter,
  load: ({ request, params }) => createInventoryRequestApiClient(request).getImportBatch(params.batchId!),
  map: (detail: InventoryImportBatchDetail) => ({ detail, detailLoadMessage: null }),
  onPending: () => ({ detail: null, detailLoadMessage: IMPORT_BATCH_UPDATING_MESSAGE }),
  messages: {
    unverified: "Import batch update could not be verified. Reload this page and try again.",
    notFound: t("inventory.features.importBatches.api.route.import.batch.not.found"),
  },
});

export async function loader(args: LoaderFunctionArgs) {
  const { request, params } = args;
  const nonFreshApi = createInventoryRequestApiClient(requestWithoutFreshWrite(request));
  const batchId = params.batchId;
  const detailResult = batchId ? await loadImportBatchDetail(args) : { detail: null, detailLoadMessage: null };

  return {
    batches: await nonFreshApi.listImportBatches(DEFAULT_IMPORT_QUERY),
    storageLocations: await nonFreshApi.listStorageLocations("limit=100&offset=0"),
    activeJobId: new URL(request.url).searchParams.get("jobId") ?? "",
    detail: detailResult.detail,
    detailLoadMessage: detailResult.detailLoadMessage,
  };
}

export const action = defineFormAction({
  authorization: { permission: "inventory.manage" },
  errorAdapter: inventoryApiErrorAdapter,
  intents: {
    "create-batch": async ({ request, formData }) => {
      const uploadedFile = formData.get("file");
      const file = uploadedFile instanceof File && uploadedFile.size > 0 ? uploadedFile : null;
      const job = await createInventoryRequestApiClient(request).createImportBatch({
        csvText: file ? await file.text() : String(formData.get("csvText") ?? ""),
        sourceKey: String(formData.get("sourceKey") ?? "native-csv"),
        quantityMode: String(formData.get("quantityMode") ?? "add"),
        defaultStorageLocationId: String(formData.get("defaultStorageLocationId") ?? "").trim() || null,
        sourceFilename: (file?.name ?? String(formData.get("sourceFilename") ?? "").trim()) || null,
      });
      return formActionRedirect(null, `/account/inventory/imports?jobId=${encodeURIComponent(job.jobId)}`);
    },
    "commit-batch": async ({ request, formData }) => {
      const batchId = String(formData.get("batchId") ?? "");
      const job = await createInventoryRequestApiClient(request).commitImportBatch(batchId);
      return formActionRedirect(null, `/account/inventory/imports/${batchId}?jobId=${encodeURIComponent(job.jobId)}`);
    },
    "resolve-row": async ({ request, formData }) => {
      const batchId = String(formData.get("batchId") ?? "");
      const rowId = String(formData.get("rowId") ?? "");
      const detail = await createInventoryRequestApiClient(request).resolveImportBatchRow(batchId, rowId, {
        catalogItemId: String(formData.get("catalogItemId") ?? ""),
        selectedOptions: parseSelectedOptionsInput(String(formData.get("selectedOptions") ?? "")),
        storageLocationId: String(formData.get("storageLocationId") ?? ""),
      });
      // Stay on the batch surface and auto-advance the drawer to the next
      // unresolved row (or close it once the batch is clean).
      return formActionRedirect(null, resolveRowRedirectTarget(batchId, detail));
    },
  },
  onUnknownIntent: () => formActionRedirect(null, "/account/inventory/imports"),
});

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
