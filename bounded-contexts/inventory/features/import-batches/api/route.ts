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
import { parseSelectedOptionsInput } from "../../inventory-items/integrations/catalog/versioning";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

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

async function parseResolveRowRequest(c: Context<InventoryApiEnv>) {
  const body = (await c.req.json().catch(() => ({}))) as Readonly<Record<string, unknown>>;

  const expectedRowVersion =
    typeof body.expectedRowVersion === "string"
      ? body.expectedRowVersion
      : typeof body.rowVersion === "string"
        ? body.rowVersion
        : undefined;
  const expectedRowFingerprint =
    typeof body.expectedRowFingerprint === "string"
      ? body.expectedRowFingerprint
      : typeof body.rowFingerprint === "string"
        ? body.rowFingerprint
        : undefined;

  return {
    ...(expectedRowVersion === undefined ? {} : { expectedRowVersion }),
    ...(expectedRowFingerprint === undefined ? {} : { expectedRowFingerprint }),
    catalogItemId: String(body.catalogItemId ?? "").trim(),
    storageLocationId: String(body.storageLocationId ?? "").trim(),
    selectedOptions: parseSelectedOptionsInput(body.selectedOptions),
  };
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
    const body = await parseResolveRowRequest(c);

    try {
      const detail = await services.resolveRow(
        {
          batchId: c.req.param("id"),
          rowId: c.req.param("rowId"),
          accountId: actor.accountId as AccountId,
          catalogItemId: body.catalogItemId,
          selectedOptions: body.selectedOptions,
          storageLocationId: body.storageLocationId,
          ...(body.expectedRowVersion === undefined ? {} : { expectedRowVersion: body.expectedRowVersion }),
          ...(body.expectedRowFingerprint === undefined ? {} : { expectedRowFingerprint: body.expectedRowFingerprint }),
        },
        c.req.header("Inventory-Mutation-Attempt")
          ? withInventoryMutationAttempt(c.get("context"), c.req.header("Inventory-Mutation-Attempt") ?? "")
          : c.get("context"),
      );
      return c.json(detail);
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
