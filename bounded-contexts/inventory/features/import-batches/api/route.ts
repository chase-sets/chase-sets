import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { InventoryApiEnv } from "../../../api";
import {
  toInventoryImportBatchJobStatus,
  type InventoryImportBatchServices,
  type InventoryImportBatchJob,
} from "./runtime";
import type { ImportCsvRow } from "../domain/csv";
import { listInventoryImportSourceProfiles, type InventoryImportSourceKey } from "../domain/import-source-profiles";
import type { InventoryImportQuantityMode } from "../domain/import-source-adapters";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  parseSelectedOptionsInput,
  type InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ImportRowResolveConflict, isImportRowFingerprint, isImportRowVersion } from "../domain/row-resolve-conflict";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("inventory.features.importBatches.api.route.request.failed");
}

function canReadJob(job: InventoryImportBatchJob | null, context: EventStoreContext): job is InventoryImportBatchJob {
  return Boolean(
    job &&
    job.payload.accountId === context.audit.forAccountId &&
    job.eventContext?.tenantId === context.tenantId &&
    job.eventContext.audit.performedByUserId === context.audit.performedByUserId,
  );
}

async function parseCreateBatchRequest(c: Context<InventoryApiEnv>) {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const allowed = ["file", "csvText", "sourceFilename", "sourceKey", "quantityMode", "defaultStorageLocationId"];
    if ([...formData.keys()].some((key) => !allowed.includes(key) || formData.getAll(key).length !== 1)) {
      throw new Error("Invalid import request.");
    }
    const file = formData.get("file");
    const uploadedFile = file instanceof File ? file : null;
    const csvText = uploadedFile
      ? new TextDecoder("utf-8", { fatal: true }).decode(await uploadedFile.arrayBuffer())
      : String(formData.get("csvText") ?? "");
    const sourceFilename = uploadedFile
      ? uploadedFile.name
      : String(formData.get("sourceFilename") ?? "").trim() || null;

    return {
      csvText,
      sourceFilename,
      sourceKey: String(formData.get("sourceKey") ?? "") || undefined,
      quantityMode: String(formData.get("quantityMode") ?? "") || undefined,
      defaultStorageLocationId: String(formData.get("defaultStorageLocationId") ?? "").trim() || null,
    };
  }

  const value: unknown = await c.req.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid import request.");
  const body = value as Readonly<Record<string, unknown>>;
  const textKeys = ["csvText", "sourceKey", "quantityMode", "defaultStorageLocationId", "sourceFilename"];
  if (
    Object.keys(body).some((key) => ![...textKeys, "parsedRows"].includes(key)) ||
    textKeys.some((key) => body[key] != null && typeof body[key] !== "string") ||
    (body.parsedRows !== undefined && !Array.isArray(body.parsedRows))
  )
    throw new Error("Invalid import request.");
  const parsedRows = body.parsedRows as readonly ImportCsvRow[] | undefined;

  return {
    csvText: typeof body.csvText === "string" ? body.csvText : undefined,
    parsedRows,
    sourceKey: typeof body.sourceKey === "string" ? body.sourceKey : undefined,
    quantityMode: typeof body.quantityMode === "string" ? body.quantityMode : undefined,
    defaultStorageLocationId:
      typeof body.defaultStorageLocationId === "string" && body.defaultStorageLocationId.trim()
        ? body.defaultStorageLocationId.trim()
        : null,
    sourceFilename:
      typeof body.sourceFilename === "string" && body.sourceFilename.trim() ? body.sourceFilename.trim() : null,
  };
}

const RESOLVE_ROW_KEYS = [
  "catalogItemId",
  "selectedOptions",
  "storageLocationId",
  "expectedRowVersion",
  "expectedRowFingerprint",
] as const;
const RESOLVE_ROW_MAX_SELECTED_OPTIONS = 64;
const RESOLVE_ROW_MAX_ID_LENGTH = 256;

type ResolveRowRequest = Readonly<{
  catalogItemId: string;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  storageLocationId: string;
  expectedRowVersion: string;
  expectedRowFingerprint: string;
}>;
type ResolveRowRefusal = "invalid_resolve_request" | "invalid_row_facts" | "missing_row_facts";

const resolveRowRefusalMessages: Readonly<Record<ResolveRowRefusal, string>> = {
  invalid_resolve_request: "Import row fix request is invalid. Reload the batch and try again.",
  invalid_row_facts: new ImportRowResolveConflict("invalid_row_facts").message,
  missing_row_facts: new ImportRowResolveConflict("missing_row_facts").message,
};

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length <= RESOLVE_ROW_MAX_ID_LENGTH;
}

function isSelectedOption(value: unknown): value is InventorySelectedOptionEntry {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 2 &&
    isBoundedId(value.dimensionId) &&
    value.dimensionId.length > 0 &&
    isBoundedId(value.optionId) &&
    value.optionId.length > 0
  );
}

/** Closed resolve body: exactly the five known keys; anything unknown, aliased, nested or mistyped is refused. */
export function parseResolveRowBody(
  value: unknown,
): Readonly<{ ok: true; body: ResolveRowRequest }> | Readonly<{ ok: false; code: ResolveRowRefusal }> {
  if (!isPlainRecord(value)) return { ok: false, code: "invalid_resolve_request" };
  const keys = Object.keys(value);
  if (
    keys.length !== RESOLVE_ROW_KEYS.length ||
    keys.some((key) => !(RESOLVE_ROW_KEYS as readonly string[]).includes(key)) ||
    !isBoundedId(value.catalogItemId) ||
    !isBoundedId(value.storageLocationId) ||
    !Array.isArray(value.selectedOptions) ||
    value.selectedOptions.length > RESOLVE_ROW_MAX_SELECTED_OPTIONS ||
    !value.selectedOptions.every(isSelectedOption)
  ) {
    return { ok: false, code: "invalid_resolve_request" };
  }
  if (value.expectedRowVersion === "" || value.expectedRowFingerprint === "") {
    return { ok: false, code: "missing_row_facts" };
  }
  if (!isImportRowVersion(value.expectedRowVersion) || !isImportRowFingerprint(value.expectedRowFingerprint)) {
    return { ok: false, code: "invalid_row_facts" };
  }
  return {
    ok: true,
    body: {
      catalogItemId: value.catalogItemId.trim(),
      storageLocationId: value.storageLocationId.trim(),
      selectedOptions: parseSelectedOptionsInput(value.selectedOptions),
      expectedRowVersion: value.expectedRowVersion,
      expectedRowFingerprint: value.expectedRowFingerprint,
    },
  };
}

function resolveRowAttemptContext(c: Context<InventoryApiEnv>): EventStoreContext | null {
  try {
    return withInventoryMutationAttempt(c.get("context"), c.req.header("Inventory-Mutation-Attempt") ?? "");
  } catch {
    return null;
  }
}

function resolveRowFailure(error: unknown) {
  if (error instanceof ImportRowResolveConflict) {
    const status = error.code === "invalid_row_facts" || error.code === "missing_row_facts" ? 400 : 409;
    return { status, body: { error: { code: error.code, message: error.message } } } as const;
  }
  return {
    status: 400,
    body: {
      error: {
        code: "validation_failed",
        // Domain messages are fixed Inventory text; anything else (driver, parser) is never echoed.
        message:
          error instanceof InventoryDomainError
            ? error.message
            : t("inventory.features.importBatches.api.route.request.failed"),
      },
    },
  } as const;
}

export function inventoryImportBatchRoutes(services: InventoryImportBatchServices) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    const limit = Number(c.req.query("limit") ?? 25);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listBatches({
      accountId: actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.post("/", async (c) => {
    const actor = c.get("actor");
    try {
      const body = await parseCreateBatchRequest(c);
      if (c.req.raw.signal.aborted) throw new Error("Import request was aborted before acceptance.");
      const job = await services.enqueueCreateBatchJob(
        {
          accountId: actor.accountId as AccountId,
          csvText: body.csvText,
          parsedRows: body.parsedRows,
          sourceKey: body.sourceKey as InventoryImportSourceKey | undefined,
          quantityMode: body.quantityMode as InventoryImportQuantityMode | undefined,
          defaultStorageLocationId: body.defaultStorageLocationId,
          sourceFilename: body.sourceFilename,
        },
        withInventoryMutationAttempt(c.get("context"), c.req.header("Inventory-Mutation-Attempt") ?? ""),
      );
      return c.json(
        { ...toInventoryImportBatchJobStatus(job), receiptVersion: 1 as const, batchId: job.payload.batchId },
        202,
      );
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("inventory.features.importBatches.api.route.import.source.not.accepted"),
          },
        },
        400,
      );
    }
  });

  app.get("/sources", (c) => {
    const items = listInventoryImportSourceProfiles();
    return c.json({
      items,
      total: items.length,
      count: items.length,
    });
  });

  app.get("/templates/native-csv", async (c) => {
    const actor = c.get("actor");
    const csv = await services.getNativeCsvTemplate({
      accountId: actor.accountId as AccountId,
    });

    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chase-sets-native-inventory-template.csv"',
    });
  });

  app.get("/exports/native-csv", async (c) => {
    const actor = c.get("actor");
    const csv = await services.getNativeCsvExport({
      accountId: actor.accountId as AccountId,
    });

    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chase-sets-native-inventory-export.csv"',
    });
  });

  app.post("/account-sku-mappings/resolve-inventory-items", async (c) => {
    const actor = c.get("actor");
    const body = (await c.req.json().catch(() => ({}))) as Readonly<{ sellerSkus?: unknown }>;
    const sellerSkus = Array.isArray(body.sellerSkus) ? body.sellerSkus.map((value) => String(value ?? "")) : [];

    const items = await services.resolveAccountSkuMappingsToInventoryItems({
      accountId: actor.accountId as AccountId,
      sellerSkus,
    });
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/:id", async (c) => {
    const actor = c.get("actor");
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      return c.json(
        {
          error: {
            code: "invalid_page",
            message: t("inventory.features.importBatches.api.route.import.row.page.invalid"),
          },
        },
        400,
      );
    }
    const detail = await services.getBatch(c.req.param("id"), actor.accountId, { limit, offset });
    if (!detail) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("inventory.features.importBatches.api.route.import.batch.not.found"),
          },
        },
        404,
      );
    }

    return c.json(detail);
  });

  app.post("/:id/commit", async (c) => {
    const actor = c.get("actor");
    try {
      const job = await services.enqueueCommitBatchJob(
        {
          batchId: c.req.param("id"),
          accountId: actor.accountId as AccountId,
        },
        withInventoryMutationAttempt(c.get("context"), c.req.header("Inventory-Mutation-Attempt") ?? ""),
      );
      return c.json(toInventoryImportBatchJobStatus(job), 202);
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: errorMessage(error),
          },
        },
        400,
      );
    }
  });

  app.post("/:id/rows/:rowId/resolve", async (c) => {
    const actor = c.get("actor");
    const parsed = parseResolveRowBody(await c.req.json().catch(() => null));
    const attemptContext = resolveRowAttemptContext(c);
    if (!parsed.ok || !attemptContext) {
      const code = parsed.ok ? "invalid_resolve_request" : parsed.code;
      return c.json({ error: { code, message: resolveRowRefusalMessages[code] } }, 400);
    }

    try {
      const detail = await services.resolveRow(
        {
          batchId: c.req.param("id"),
          rowId: c.req.param("rowId"),
          accountId: actor.accountId as AccountId,
          ...parsed.body,
        },
        attemptContext,
      );
      return c.json(detail);
    } catch (error) {
      const failure = resolveRowFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  app.get("/jobs/:jobId", async (c) => {
    const job = await services.getImportBatchJob(c.req.param("jobId"));
    if (!canReadJob(job, c.get("context"))) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("inventory.features.importBatches.api.route.import.batch.not.found"),
          },
        },
        404,
      );
    }

    return c.json(toInventoryImportBatchJobStatus(job));
  });

  app.get("/jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await services.getImportBatchJob(jobId);
    if (!canReadJob(job, c.get("context"))) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("inventory.features.importBatches.api.route.import.batch.not.found"),
          },
        },
        404,
      );
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: `account:${c.get("actor").accountId}`,
      loadEvents: async (afterSequence) =>
        (await services.listImportBatchJobEvents(jobId, afterSequence)).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.job,
        })),
      loadCurrentSnapshot: async () => {
        const current = await services.getImportBatchJob(jobId);
        return canReadJob(current, c.get("context")) && current ? toInventoryImportBatchJobStatus(current) : null;
      },
      waitForEvents: (_afterSequence, signal) => services.waitForImportBatchJobEvents(jobId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });

  return app;
}
