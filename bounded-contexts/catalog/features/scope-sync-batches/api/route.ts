import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  ScopeSyncBatchBlockedPreviewError,
  ScopeSyncBatchStalePreviewError,
  type ScopeSyncBatchBudget,
  type ScopeSyncBatchSelection,
} from "../domain/batch";
import type { ScopeSyncBatchServices } from "./runtime";

type Env = { Variables: { context: EventStoreContext } };

export function scopeSyncBatchRoutes(services: ScopeSyncBatchServices) {
  const app = new Hono<Env>();

  app.post("/preview", async (c) => {
    const body = await c.req.json<unknown>();
    const request = parsePreviewRequest(body);
    return c.json(await services.preview({ ...request, context: c.get("context") }));
  });

  app.post("/confirm", async (c) => {
    try {
      const body = await c.req.json<unknown>();
      const request = parseConfirmRequest(body);
      return c.json(await services.confirm({ ...request, context: c.get("context") }), 202);
    } catch (error) {
      if (error instanceof ScopeSyncBatchStalePreviewError || error instanceof ScopeSyncBatchBlockedPreviewError) {
        return c.json(
          {
            error: { code: error.code, message: error.message },
            currentPreview: error.currentPreview,
          },
          409,
        );
      }
      throw error;
    }
  });

  app.get("/:batchId", async (c) => {
    const batch = await services.get({ batchId: c.req.param("batchId"), context: c.get("context") });
    return batch
      ? c.json(batch)
      : c.json({ error: { code: "not_found", message: "Scope Sync Batch was not found." } }, 404);
  });

  app.post("/:batchId/cancel", async (c) => {
    const batch = await services.cancel({ batchId: c.req.param("batchId"), context: c.get("context") });
    return batch
      ? c.json(batch)
      : c.json({ error: { code: "not_found", message: "Scope Sync Batch was not found." } }, 404);
  });
  app.post("/:batchId/resume", async (c) => {
    const batch = await services.resume({ batchId: c.req.param("batchId"), context: c.get("context") });
    return batch
      ? c.json(batch)
      : c.json({ error: { code: "not_found", message: "Scope Sync Batch was not found." } }, 404);
  });
  app.post("/:batchId/units/:scopeRecordId/retry", async (c) => {
    const batch = await services.retryUnit({
      batchId: c.req.param("batchId"),
      scopeRecordId: c.req.param("scopeRecordId"),
      context: c.get("context"),
    });
    return batch
      ? c.json(batch)
      : c.json({ error: { code: "not_found", message: "Scope Sync Batch was not found." } }, 404);
  });

  return app;
}

function parsePreviewRequest(input: unknown): {
  selection: ScopeSyncBatchSelection;
  budget?: Partial<ScopeSyncBatchBudget> | null;
} {
  const body = record(input, "Scope Sync Batch request body is required.");
  return {
    selection: parseSelection(body.selection),
    budget: optionalRecord(body.budget) as Partial<ScopeSyncBatchBudget>,
  };
}

function parseConfirmRequest(input: unknown) {
  const request = parsePreviewRequest(input);
  const body = record(input, "Scope Sync Batch request body is required.");
  const planFingerprint = stringValue(body.planFingerprint, "planFingerprint is required.");
  return { ...request, planFingerprint };
}

function parseSelection(input: unknown): ScopeSyncBatchSelection {
  const selection = record(input, "selection is required.");
  if (selection.mode === "ids") {
    if (!Array.isArray(selection.scopeRecordIds)) throw new Error("selection.scopeRecordIds must be an array.");
    return {
      mode: "ids",
      scopeRecordIds: selection.scopeRecordIds.map((id) => stringValue(id, "scopeRecordId is required.")),
    };
  }
  if (selection.mode === "matching-scope") {
    const query = optionalRecord(selection.query);
    const scopeKind = optionalString(query.scopeKind);
    if (scopeKind && !["product-line", "series", "expansion", "set"].includes(scopeKind)) {
      throw new Error("selection.query.scopeKind is invalid.");
    }
    return {
      mode: "matching-scope",
      query: {
        productDomain: optionalString(query.productDomain),
        scopeKind: scopeKind as "product-line" | "series" | "expansion" | "set" | null,
        languageCode: optionalString(query.languageCode),
      },
    };
  }
  throw new Error("selection.mode must be ids or matching-scope.");
}

function record(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(message);
  return input as Record<string, unknown>;
}

function optionalRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function stringValue(input: unknown, message: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(message);
  return input.trim();
}

function optionalString(input: unknown): string | null {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}
