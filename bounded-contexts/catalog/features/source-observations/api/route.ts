import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { SourceObservationServices } from "./runtime";

export function sourceObservationRoutes(services: SourceObservationServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/", async (c) => {
    const { search, status, limit, offset, provider, language } = c.req.query();
    const result = await services.listSourceObservations({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      provider,
      language,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.post("/imports/tcgdex-set", async (c) => {
    const body = await c.req.json();
    const result = await services.importTcgdexSet({
      languageCode: String(body.languageCode ?? "en"),
      setId: String(body.setId ?? ""),
      context: c.get("context"),
    });

    return c.json(result, 201);
  });

  app.post("/bulk-promote", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
    };
    const observationIds = Array.isArray(body.observationIds)
      ? body.observationIds.map((observationId: unknown) => String(observationId))
      : [];
    const result = await services.promoteObservations({
      observationIds,
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
