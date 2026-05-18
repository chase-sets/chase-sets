import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { SourceObservationServices } from "./runtime";
import type { SourceObservationFilterScope } from "../read-model/queries";

export function sourceObservationRoutes(services: SourceObservationServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/", async (c) => {
    const { search, status, limit, offset, provider, source, language, setId, expansionId } = c.req.query();
    const result = await services.listSourceObservations({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      provider: provider ?? source,
      language,
      setId: expansionId ?? setId,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/integration-scopes", async (c) => {
    const { provider, source, language, setId, expansionId } = c.req.query();
    const items = await services.listIntegrationScopes({
      provider: provider ?? source,
      language,
      setId: expansionId ?? setId,
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-options", async (c) => {
    const items = await services.listIntegrationOptions({
      providerKey: String(c.req.query("providerKey") ?? c.req.query("provider") ?? "tcgdex"),
      queryKind: String(c.req.query("queryKind") ?? c.req.query("kind") ?? ""),
      languageCode: c.req.query("languageCode") ?? c.req.query("language"),
      parentValue:
        c.req.query("parentValue") ??
        c.req.query("seriesId") ??
        c.req.query("series"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/imports/tcgdex-set", async (c) => {
    const body = await c.req.json();
    const result = await services.importTcgdexSet({
      languageCode: String(body.languageCode ?? "en"),
      setId: String(body.expansionId ?? body.setId ?? ""),
      context: c.get("context"),
    });

    return c.json(result, 201);
  });

  app.get("/tcgdex/languages", async (c) => {
    const items = await services.listTcgdexLanguages();
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/tcgdex/series", async (c) => {
    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    const items = await services.listTcgdexSeries({ languageCode });
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/tcgdex/expansions", async (c) => {
    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    const seriesId = c.req.query("seriesId") ?? c.req.query("series");
    const items = await services.listTcgdexExpansions({ languageCode, seriesId });
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/bulk-promote/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };
    const result = await services.previewPromoteObservationScope({
      scope: parsePromotionScope(body.scope),
    });

    return c.json(result);
  });

  app.post("/bulk-promote", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };

    if (body.scope) {
      const result = await services.promoteObservationScope({
        scope: parsePromotionScope(body.scope),
        context: c.get("context"),
      });

      return c.json(result);
    }

    const observationIds = Array.isArray(body.observationIds)
      ? body.observationIds.map((observationId: unknown) => String(observationId))
      : [];
    const result = await services.promoteObservations({
      observationIds,
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/bulk-reject", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reason?: unknown;
    };
    const reason = String(body.reason ?? "").trim();

    if (!reason) {
      return c.json({
        error: t("catalog.features.sourceObservations.api.route.bulk.rejection.requires.reason"),
      }, 400);
    }

    if (body.scope) {
      const result = await services.rejectObservationScope({
        scope: parsePromotionScope(body.scope),
        reason,
        context: c.get("context"),
      });

      return c.json(result);
    }

    const observationIds = Array.isArray(body.observationIds)
      ? body.observationIds.map((observationId: unknown) => String(observationId))
      : [];
    const result = await services.rejectObservations({
      observationIds,
      reason,
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.get("/:id", async (c) => {
    const observation = await services.getSourceObservationDetail(c.req.param("id"));
    if (!observation) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.source.observation.not.found"),
          },
        },
        404,
      );
    }

    return c.json(observation);
  });

  app.post("/:id/promote", async (c) => {
    const result = await services.promoteObservation({
      observationId: c.req.param("id"),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.rejectObservation({
      observationId: c.req.param("id"),
      reason: String(body.reason ?? "Rejected during review."),
      context: c.get("context"),
    });

    return c.json(result);
  });

  return app;
}

function parsePromotionScope(input: unknown): SourceObservationFilterScope {
  if (!input || typeof input !== "object") {
    return {};
  }

  const record = input as Record<string, unknown>;

  return {
    search: stringField(record.search),
    status: stringField(record.status),
    provider: stringField(record.provider) ?? stringField(record.source),
    language: stringField(record.language),
    setId: stringField(record.expansionId) ?? stringField(record.setId),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
