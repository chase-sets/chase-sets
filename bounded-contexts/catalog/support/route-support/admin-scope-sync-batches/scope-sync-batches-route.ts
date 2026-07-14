import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import type { ScopeSyncBatchPreview } from "../../../features/scope-sync-batches/domain/batch";
import type { ScopeSyncBatchSnapshot } from "../../../features/scope-sync-batches/read-model/store";

export type ScopeSyncBatchRouteActionData = Readonly<{
  preview: ScopeSyncBatchPreview | null;
  error: string | null;
}>;

export async function loader({ request }: LoaderFunctionArgs): Promise<{ batch: ScopeSyncBatchSnapshot | null }> {
  const batchId = new URL(request.url).searchParams.get("batchId")?.trim();
  if (!batchId) return { batch: null };
  const api = createCatalogRequestApiClient(request);
  return { batch: await api.getScopeSyncBatch<ScopeSyncBatchSnapshot>(batchId) };
}

export async function action({ request }: ActionFunctionArgs): Promise<ScopeSyncBatchRouteActionData | Response> {
  const formData = await request.formData();
  const intent = stringValue(formData.get("intent"));
  const api = createCatalogRequestApiClient(request);

  try {
    if (intent === "preview") {
      return { preview: await api.previewScopeSyncBatch<ScopeSyncBatchPreview>(previewRequest(formData)), error: null };
    }
    if (intent === "confirm") {
      const batch = await api.confirmScopeSyncBatch<ScopeSyncBatchSnapshot>({
        ...previewRequest(formData),
        planFingerprint: requiredString(formData.get("planFingerprint"), "Plan fingerprint is required."),
      });
      return redirect(`/catalog/scopes/sync-batches?batchId=${encodeURIComponent(batch.batchId)}`);
    }

    const batchId = requiredString(formData.get("batchId"), "Batch id is required.");
    if (intent === "cancel") await api.cancelScopeSyncBatch(batchId);
    else if (intent === "resume") await api.resumeScopeSyncBatch(batchId);
    else if (intent === "retry-unit") {
      await api.retryScopeSyncBatchUnit(
        batchId,
        requiredString(formData.get("scopeRecordId"), "Scope Record id is required."),
      );
    } else throw new Error("Scope Sync Batch command is not supported.");
    return redirect(`/catalog/scopes/sync-batches?batchId=${encodeURIComponent(batchId)}`);
  } catch (error) {
    return { preview: null, error: error instanceof Error ? error.message : "Scope Sync Batch command failed." };
  }
}

function previewRequest(formData: FormData) {
  const mode = stringValue(formData.get("selectionMode"));
  const selection =
    mode === "ids"
      ? {
          mode: "ids" as const,
          scopeRecordIds: stringValue(formData.get("scopeRecordIds"))
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {
          mode: "matching-scope" as const,
          query: {
            productDomain: optionalString(formData.get("productDomain")),
            scopeKind: optionalString(formData.get("scopeKind")),
            languageCode: optionalString(formData.get("languageCode")),
          },
        };
  return {
    selection,
    budget: {
      maxScopesPerTurn: numberValue(formData.get("maxScopesPerTurn"), 1),
      defaultProviderConcurrency: numberValue(formData.get("defaultProviderConcurrency"), 1),
      providerConcurrency: { scrydex: numberValue(formData.get("scrydexConcurrency"), 1) },
      providerRequestLimits: {
        tcgdex: numberValue(formData.get("tcgdexRequestLimit"), 0),
        scrydex: numberValue(formData.get("scrydexRateRequestLimit"), 0),
      },
      creditedProviderRequestLimits: { scrydex: numberValue(formData.get("scrydexRequestLimit"), 0) },
      providerFailureThreshold: numberValue(formData.get("providerFailureThreshold"), 3),
    },
  };
}

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: FormDataEntryValue | null): string | null {
  return stringValue(value) || null;
}

function requiredString(value: FormDataEntryValue | null, message: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(message);
  return parsed;
}

function numberValue(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number(stringValue(value));
  return Number.isInteger(parsed) ? parsed : fallback;
}
