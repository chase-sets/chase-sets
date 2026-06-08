import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { IntegrationJobServices, ProviderOptionQueryServices } from "./runtime";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "./catalog-integration-rollout-controls";

export type ProviderCompatibilityRouteServices = ProviderOptionQueryServices &
  Pick<IntegrationJobServices, "enqueueIntegrationJob">;

export function providerCompatibilityRoutes(services: ProviderCompatibilityRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/imports/tcgdex-set", async (c) => {
    const body = await c.req.json();
    let job;
    try {
      job = await services.enqueueIntegrationJob({
        action: "import",
        scope: {
          provider: "tcgdex",
          language: String(body.languageCode ?? "en"),
          setId: String(body.expansionId ?? body.setId ?? ""),
        },
        context: c.get("context"),
      });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }

    return c.json(job, 202);
  });

  app.get("/tcgdex/languages", async (c) => {
    let items;
    try {
      items = await services.listTcgdexLanguages();
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/tcgdex/series", async (c) => {
    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    let items;
    try {
      items = await services.listTcgdexSeries({ languageCode });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/tcgdex/expansions", async (c) => {
    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    const seriesId = c.req.query("seriesId") ?? c.req.query("series");
    let items;
    try {
      items = await services.listTcgdexExpansions({ languageCode, seriesId });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }
    return c.json({ items, total: items.length, count: items.length });
  });

  return app;
}
