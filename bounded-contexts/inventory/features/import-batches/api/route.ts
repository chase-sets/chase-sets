import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { InventoryApiEnv } from "../../../api";
import { toInventoryImportBatchJobStatus, type InventoryImportBatchServices } from "./runtime";
import type { ImportCsvRow } from "../domain/csv";
import { listInventoryImportSourceProfiles, type InventoryImportSourceKey } from "../domain/import-source-profiles";
import type { InventoryImportQuantityMode } from "../domain/import-source-adapters";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { parseSelectedOptionsInput } from "../../inventory-items/integrations/catalog/versioning";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("inventory.features.importBatches.api.route.request.failed");
}

async function parseCreateBatchRequest(c: Context<InventoryApiEnv>) {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    const uploadedFile = file instanceof File ? file : null;
    const csvText = uploadedFile ? await uploadedFile.text() : String(formData.get("csvText") ?? "");
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

  const body = (await c.req.json().catch(() => ({}))) as Readonly<Record<string, unknown>>;
  const parsedRows = Array.isArray(body.parsedRows)
    ? body.parsedRows
        .map((row): ImportCsvRow | null => {
          if (typeof row !== "object" || row === null) {
            return null;
          }

          const record = row as Readonly<Record<string, unknown>>;
          const values =
            typeof record.values === "object" && record.values !== null && !Array.isArray(record.values)
              ? Object.fromEntries(Object.entries(record.values).map(([key, value]) => [key, String(value ?? "")]))
              : null;

          return values
            ? {
                rowNumber: Number(record.rowNumber ?? 0),
                values,
              }
            : null;
        })
        .filter((row): row is ImportCsvRow => row !== null && row.rowNumber > 0)
    : undefined;

  return {
    csvText: String(body.csvText ?? ""),
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

  return {
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
    const body = await parseCreateBatchRequest(c);

    try {
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
        c.get("context"),
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
    const detail = await services.getBatch(c.req.param("id"), actor.accountId);
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
        c.get("context"),
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
        },
        c.get("context"),
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
    if (!job || job.payload.accountId !== c.get("actor").accountId) {
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
    if (!job || job.payload.accountId !== c.get("actor").accountId) {
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
        return current && current.payload.accountId === c.get("actor").accountId
          ? toInventoryImportBatchJobStatus(current)
          : null;
      },
      waitForEvents: (_afterSequence, signal) => services.waitForImportBatchJobEvents(jobId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });

  return app;
}
