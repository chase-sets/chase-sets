import { Hono, type Context, type Next } from "hono";
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
import { countCaptureFields } from "../domain/count-capture-plan";
import {
  countCaptureFreezeInputSchema,
  countCapturePlannerInputSchema,
  type CountCaptureLifecycle,
  type CountCaptureSession,
} from "./count-capture-lifecycle";
import { z } from "zod";

type Env = { Variables: { context: EventStoreContext; actor: ResolvedActor | null } };
// The explicit capture marker. Without it the capture paths stay unrouted.
const countCaptureMarker = "x-catalog-count-capture";
const captureBodies = {
  baseline: z.object({ scopeRecordId: countCaptureFields.id, authority: z.unknown() }).strict(),
  empty: z.object({}).strict(),
};

// Count and capture commands need a same-origin platform-admin with Catalog access.
async function adminCountAccess(c: Context<Env>, next: Next) {
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
}

export function scopeSyncBatchRoutes(services: ScopeSyncBatchServices, capture: CountCaptureLifecycle | null = null) {
  const app = new Hono<Env>();
  app.use("/counts/*", adminCountAccess);
  app.use("/count-capture/*", async (c, next) => {
    const marker = c.req.header(countCaptureMarker);
    if (marker === undefined) return c.notFound();
    c.header("Cache-Control", "no-store");
    if (marker !== "1" || !capture) return c.json({ error: { code: "capture-stopped" } }, 409);
    return adminCountAccess(c, next);
  });
  app.use("*", async (c, next) => {
    const marker = c.req.header(countCaptureMarker);
    if (marker !== undefined && !c.req.path.includes("/count-capture/")) {
      c.header("Cache-Control", "no-store");
      if (
        marker !== "1" ||
        !capture ||
        !["/counts/quote", "/counts/acquire", "/preview"].some((path) => c.req.path.endsWith(path))
      )
        return c.json({ error: { code: "capture-stopped" } }, 409);
    }
    await next();
  });
  // Every capture outcome is uncacheable, and every failure is one support-safe refusal.
  const captureStep =
    <T>(body: z.ZodType<T>, work: (session: CountCaptureSession, input: T) => Promise<unknown>) =>
    async (c: Context<Env>) => {
      c.header("Cache-Control", "no-store");
      try {
        const session = { request: c.req.raw, actor: c.get("actor"), context: c.get("context") };
        return c.json(await work(session, body.parse(await c.req.json())));
      } catch {
        return c.json({ error: { code: "capture-stopped" } }, 409);
      }
    };
  app.post(
    "/count-capture/baseline",
    captureStep(captureBodies.baseline, (session, input) => capture!.baseline(session, input)),
  );
  app.post(
    "/count-capture/initial-notice",
    captureStep(captureBodies.empty, (session) => capture!.initialNotice(session)),
  );
  app.post(
    "/count-capture/usage",
    captureStep(captureBodies.empty, (session) => capture!.usage(session)),
  );
  app.post(
    "/count-capture/quote-readback",
    captureStep(captureBodies.empty, (session) => capture!.quoteReadback(session)),
  );
  app.post(
    "/count-capture/final-notice",
    captureStep(captureBodies.empty, (session) => capture!.finalNotice(session)),
  );
  app.post(
    "/count-capture/freeze",
    captureStep(countCaptureFreezeInputSchema, (session, input) => capture!.freeze(session, input)),
  );
  app.post(
    "/count-capture/pre-confirm",
    captureStep(
      countCapturePlannerInputSchema.extend({ planFingerprint: countCaptureFields.hash }).strict(),
      (session, input) => capture!.preConfirm(session, input),
    ),
  );
  app.onError((error, c) => {
    if (error instanceof CountAcquisitionRefused)
      return c.json({ error: { code: error.code, message: error.message } }, 409);
    if (error instanceof z.ZodError) return c.json({ error: { code: "invalid-count-request" } }, 400);
    throw error;
  });
  app.post("/counts/quote", async (c) => {
    if (c.req.header(countCaptureMarker) !== undefined)
      return captureStep(countCapturePlannerInputSchema, (session, input) => capture!.quote(session, input))(c);
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
    if (c.req.header(countCaptureMarker) !== undefined)
      return captureStep(
        z.object({ quoteId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        (session, input) => capture!.acquire(session, input),
      )(c);
    const body = z
      .object({
        quoteId: z.uuid(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        admission: z.literal("whole-quote").optional(),
      })
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
    const query = z
      .object({ view: z.literal("preparation").optional() })
      .strict()
      .parse(c.req.query());
    return c.json(await services.getCountQuote({ quoteId, ...query, context: c.get("context") }));
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
    if (c.req.header(countCaptureMarker) !== undefined)
      return captureStep(countCapturePlannerInputSchema, (session, input) => capture!.preview(session, input))(c);
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
