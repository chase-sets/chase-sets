import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { t } from "@chase-sets/localization";
import {
  ScopeSyncBatchBlockedPreviewError,
  ScopeSyncBatchStalePreviewError,
  type ScopeSyncBatchBudget,
  type ScopeSyncBatchSelection,
} from "../domain/batch";
import type { ScopeSyncBatchServices } from "./runtime";
import { HeldSetExportError } from "../domain/held-set-export";
import { readHeldSetExportUpload } from "./held-set-upload";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { CountAcquisitionRefused } from "../domain/count-acquisition";
import { z } from "zod";
import { CountCaptureStopped } from "./count-capture-context";

type Env = { Variables: { context: EventStoreContext; actor: ResolvedActor | null } };

export function scopeSyncBatchRoutes(services: ScopeSyncBatchServices) {
  const app = new Hono<Env>();
  app.use("/count-capture/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/preview", async (c, next) => {
    if (c.req.header("x-catalog-count-capture") !== undefined) c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/counts/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "unauthenticated" } }, 401);
    if (
      actor.roleKey !== "platform-admin" ||
      !actor.permissions.includes(c.req.method === "GET" ? "catalog.view" : "catalog.manage")
    )
      return c.json({ error: { code: "forbidden" } }, 403);
    if (
      c.req.method !== "GET" &&
      (c.req.header("origin") !== resolvePublicRequestOrigin(c.req.raw) ||
        c.req.header("sec-fetch-site") === "cross-site")
    )
      return c.json({ error: { code: "forbidden" } }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof CountCaptureStopped) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: { code: "capture-stopped" } }, 409);
    }
    if (error instanceof CountAcquisitionRefused)
      return c.json({ error: { code: error.code, message: error.message } }, 409);
    if (error instanceof z.ZodError) return c.json({ error: { code: "invalid-count-request" } }, 400);
    throw error;
  });
  app.post("/counts/quote", async (c) => {
    const body = z
      .object({ selection: z.unknown(), cap: z.number().int().min(0).max(10_000).optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await services.quoteCounts({
        selection: parseSelection(body.selection),
        cap: body.cap,
        context: c.get("context"),
      }),
    );
  });
  app.post("/counts/acquire", async (c) => {
    const body = z
      .object({ quoteId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(await c.req.json());
    return c.json(await services.acquireCounts({ ...body, context: c.get("context") }));
  });
  app.get("/counts/spend", async (c) => {
    const input = z
      .object({
        before: z.iso.datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(c.req.query());
    return c.json(await services.countSpend(input));
  });
  app.get("/counts/quote/:quoteId", async (c) => {
    const quoteId = z.uuid().parse(c.req.param("quoteId"));
    return c.json(await services.getCountQuote({ quoteId, context: c.get("context") }));
  });

  app.post("/resolve-held-sets", async (c) => {
    try {
      const bytes = await readHeldSetExportUpload(c.req.raw);
      return c.json(await services.resolveHeldSets({ bytes, context: c.get("context") }));
    } catch (error) {
      if (error instanceof HeldSetExportError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.code === "upload-too-large" ? 413 : 400,
        );
      }
      throw error;
    }
  });

  app.post("/preview", async (c) => {
    const body = await c.req.json<unknown>();
    const request = parsePreviewRequest(body);
    if (c.req.header("x-catalog-count-capture") !== undefined) {
      c.header("Cache-Control", "no-store");
      if (c.req.header("x-catalog-count-capture") !== "1" || !services.capture) throw new CountCaptureStopped();
      return c.json(
        await services.capture.preview(
          { request: c.req.raw, actor: c.get("actor"), context: c.get("context") },
          request,
        ),
      );
    }
    return c.json(await services.preview({ ...request, context: c.get("context") }));
  });

  app.post("/count-capture/pre-confirm", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!services.capture) throw new CountCaptureStopped();
    const body = z
      .object({
        selection: z.unknown(),
        budget: z.unknown().optional(),
        planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await services.capture.preConfirm(
        { request: c.req.raw, actor: c.get("actor"), context: c.get("context") },
        parseConfirmRequest(body),
      ),
    );
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
      : c.json(
          { error: { code: "not_found", message: t("catalog.features.scopeSyncBatches.api.route.not.found") } },
          404,
        );
  });

  app.post("/:batchId/cancel", async (c) => {
    const batch = await services.cancel({ batchId: c.req.param("batchId"), context: c.get("context") });
    return batch
      ? c.json(batch)
      : c.json(
          { error: { code: "not_found", message: t("catalog.features.scopeSyncBatches.api.route.not.found") } },
          404,
        );
  });
  app.post("/:batchId/resume", async (c) => {
    const batch = await services.resume({ batchId: c.req.param("batchId"), context: c.get("context") });
    return batch
      ? c.json(batch)
      : c.json(
          { error: { code: "not_found", message: t("catalog.features.scopeSyncBatches.api.route.not.found") } },
          404,
        );
  });
  app.post("/:batchId/units/:scopeRecordId/retry", async (c) => {
    const batch = await services.retryUnit({
      batchId: c.req.param("batchId"),
      scopeRecordId: c.req.param("scopeRecordId"),
      context: c.get("context"),
    });
    return batch
      ? c.json(batch)
      : c.json(
          { error: { code: "not_found", message: t("catalog.features.scopeSyncBatches.api.route.not.found") } },
          404,
        );
  });

  return app;
}

function parsePreviewRequest(input: unknown): {
  selection: ScopeSyncBatchSelection;
  budget?: Partial<ScopeSyncBatchBudget> | null;
} {
  const body = record(input, t("catalog.features.scopeSyncBatches.api.route.request.body.required"));
  return {
    selection: parseSelection(body.selection),
    budget: optionalRecord(body.budget) as Partial<ScopeSyncBatchBudget>,
  };
}

function parseConfirmRequest(input: unknown) {
  const request = parsePreviewRequest(input);
  const body = record(input, t("catalog.features.scopeSyncBatches.api.route.request.body.required"));
  const planFingerprint = stringValue(
    body.planFingerprint,
    t("catalog.features.scopeSyncBatches.api.route.plan.fingerprint.required"),
  );
  return { ...request, planFingerprint };
}

function parseSelection(input: unknown): ScopeSyncBatchSelection {
  const selection = record(input, t("catalog.features.scopeSyncBatches.api.route.selection.required"));
  if (selection.mode === "ids") {
    if (!Array.isArray(selection.scopeRecordIds)) {
      throw new Error(t("catalog.features.scopeSyncBatches.api.route.scope.record.ids.must.be.array"));
    }
    return {
      mode: "ids",
      scopeRecordIds: selection.scopeRecordIds.map((id) =>
        stringValue(id, t("catalog.features.scopeSyncBatches.api.route.scope.record.id.required")),
      ),
    };
  }
  if (selection.mode === "matching-scope") {
    const query = optionalRecord(selection.query);
    const scopeKind = optionalString(query.scopeKind);
    if (scopeKind && !["product-line", "series", "expansion", "set"].includes(scopeKind)) {
      throw new Error(t("catalog.features.scopeSyncBatches.api.route.scope.kind.invalid"));
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
  throw new Error(t("catalog.features.scopeSyncBatches.api.route.selection.mode.invalid"));
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
