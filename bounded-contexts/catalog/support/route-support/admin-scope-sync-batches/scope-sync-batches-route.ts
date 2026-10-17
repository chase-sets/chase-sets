import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import type { ScopeSyncBatchPreview } from "../../../features/scope-sync-batches/domain/batch";
import type { ScopeSyncBatchSnapshot } from "../../../features/scope-sync-batches/read-model/store";
import {
  HeldSetExportError,
  type HeldSetResolution,
} from "../../../features/scope-sync-batches/domain/held-set-export";
import { readHeldSetExportAdminUpload } from "../../../features/scope-sync-batches/api/held-set-upload";
import type { CountQuote } from "../../../features/scope-sync-batches/domain/count-acquisition";

export type ScopeSyncBatchRouteActionData = Readonly<{
  preview: ScopeSyncBatchPreview | null;
  heldSetResolution: HeldSetResolution | null;
  error: string | null;
  countQuote?: CountQuote | null;
}>;

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<{ batch: ScopeSyncBatchSnapshot | null; countQuote: CountQuote | null }> {
  const batchId = new URL(request.url).searchParams.get("batchId")?.trim();
  const quoteId = new URL(request.url).searchParams.get("quoteId")?.trim();
  if (!batchId && !quoteId) return { batch: null, countQuote: null };
  const api = createCatalogRequestApiClient(request);
  return {
    batch: batchId ? await api.getScopeSyncBatch<ScopeSyncBatchSnapshot>(batchId) : null,
    countQuote: quoteId ? await api.getScopeSyncCountQuote<CountQuote>(quoteId) : null,
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<ScopeSyncBatchRouteActionData | Response> {
  try {
    const api = createCatalogRequestApiClient(request);
    if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const { file } = await readHeldSetExportAdminUpload(request);
      return { heldSetResolution: await api.resolveHeldSetExport<HeldSetResolution>(file), preview: null, error: null };
    }
    const formData = await request.formData();
    if (formData.has("countCapture")) return await captureAction(api, formData);
    const intent = stringValue(formData.get("intent"));
    if (intent === "count-quote")
      return {
        preview: null,
        heldSetResolution: null,
        error: null,
        countQuote: await api.quoteScopeSyncCounts<CountQuote>({
          selection: previewRequest(formData).selection,
          cap: numberValue(formData.get("countCap"), 0),
        }),
      };
    if (intent === "count-acquire")
      return {
        preview: null,
        heldSetResolution: null,
        error: null,
        countQuote: await api.acquireScopeSyncCounts<CountQuote>({
          quoteId: requiredString(formData.get("quoteId"), "Count quote is required."),
          fingerprint: requiredString(formData.get("countFingerprint"), "Count fingerprint is required."),
        }),
      };
    if (intent === "preview") {
      return {
        preview: await api.previewScopeSyncBatch<ScopeSyncBatchPreview>(previewRequest(formData)),
        heldSetResolution: null,
        error: null,
      };
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
    return {
      preview: null,
      heldSetResolution: null,
      error: error instanceof Error ? error.message : "Scope Sync Batch command failed.",
    };
  }
}

// Staging count-capture steps, engaged only by the explicit marker. The form is
// closed per step and the API owns validation; every outcome is uncacheable and
// every failure is one support-safe refusal.
const captureFields: Readonly<Record<string, readonly string[]>> = {
  "capture-baseline": ["intent", "countCapture", "scopeRecordId", "authority"],
  "capture-initial-notice": ["intent", "countCapture"],
  "capture-usage": ["intent", "countCapture"],
  "count-quote": ["intent", "countCapture", "selectionMode", "scopeRecordIds", "budget"],
  "capture-quote-readback": ["intent", "countCapture"],
  "capture-final-notice": ["intent", "countCapture"],
  "count-acquire": ["intent", "countCapture", "quoteId", "countFingerprint"],
  preview: ["intent", "countCapture", "selectionMode", "scopeRecordIds", "budget"],
  "pre-confirm-planner-read": [
    "intent",
    "countCapture",
    "selectionMode",
    "scopeRecordIds",
    "budget",
    "planFingerprint",
  ],
  "capture-freeze": ["intent", "countCapture", "freeze"],
};
async function captureAction(api: ReturnType<typeof createCatalogRequestApiClient>, formData: FormData) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const intent = formData.get("intent");
    const fields = typeof intent === "string" ? captureFields[intent] : undefined;
    if (
      formData.get("countCapture") !== "1" ||
      !fields ||
      [...formData.keys()].some((key) => !fields.includes(key) || formData.getAll(key).length !== 1) ||
      fields.some((key) => typeof formData.get(key) !== "string")
    )
      throw new Error("capture-stopped");
    if (intent === "capture-baseline") {
      const authority = formData.get("authority") as string;
      if (authority.length > 16_384) throw new Error("capture-stopped");
      return Response.json(
        await api.captureScopeSyncCountBaseline({
          scopeRecordId: formData.get("scopeRecordId") as string,
          authority: JSON.parse(authority) as unknown,
        }),
        { headers },
      );
    }
    if (intent === "capture-initial-notice")
      return Response.json(await api.captureScopeSyncCountInitialNotice(), { headers });
    if (intent === "capture-usage") return Response.json(await api.captureScopeSyncCountUsage(), { headers });
    if (intent === "capture-quote-readback")
      return Response.json(await api.readBackScopeSyncCaptureQuote(), { headers });
    if (intent === "capture-final-notice")
      return Response.json(await api.recordScopeSyncCaptureFinalNotice(), { headers });
    if (intent === "count-acquire")
      return Response.json(
        await api.acquireScopeSyncCaptureCounts({
          quoteId: formData.get("quoteId") as string,
          fingerprint: formData.get("countFingerprint") as string,
        }),
        { headers },
      );
    if (intent === "capture-freeze") {
      const freeze = formData.get("freeze") as string;
      if (freeze.length > 16_384) throw new Error("capture-stopped");
      return Response.json(
        await api.freezeScopeSyncCountCapture(
          JSON.parse(freeze) as Parameters<typeof api.freezeScopeSyncCountCapture>[0],
        ),
        { headers },
      );
    }
    if (formData.get("selectionMode") !== "ids") throw new Error("capture-stopped");
    const encodedBudget = formData.get("budget") as string;
    if (encodedBudget.length > 4096) throw new Error("capture-stopped");
    const input = {
      selection: { mode: "ids" as const, scopeRecordIds: (formData.get("scopeRecordIds") as string).split(",") },
      budget: JSON.parse(encodedBudget) as Parameters<typeof api.previewScopeSyncCountCapture>[0]["budget"],
    };
    if (intent === "count-quote") return Response.json(await api.quoteScopeSyncCaptureCounts(input), { headers });
    if (intent === "preview") return Response.json(await api.previewScopeSyncCountCapture(input), { headers });
    return Response.json(
      await api.preConfirmScopeSyncCountCapture({
        ...input,
        planFingerprint: formData.get("planFingerprint") as string,
      }),
      { headers },
    );
  } catch {
    return Response.json(
      { preview: null, heldSetResolution: null, error: "capture-stopped" },
      { status: 409, headers },
    );
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
