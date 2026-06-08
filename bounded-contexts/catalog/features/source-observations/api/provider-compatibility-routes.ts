import { Hono } from "hono";
import type { Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { IntegrationJobServices, ProviderOptionQueryServices } from "./runtime";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "./catalog-integration-rollout-controls";
import { CatalogProviderOptionQueryUnavailableError } from "./provider-option-query-cache";
import { requireCatalogIntegrationControlPlanePermission } from "./admin-control-plane-rbac";

export type ProviderCompatibilityRouteServices = ProviderOptionQueryServices &
  Pick<IntegrationJobServices, "enqueueIntegrationJob">;

export function providerCompatibilityRoutes(services: ProviderCompatibilityRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/imports/tcgdex-set", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "legacy-provider-import");
    if (permissionError) {
      return permissionError;
    }

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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    try {
      if (typeof services.queryIntegrationOptions === "function") {
        const page = await services.queryIntegrationOptions({
          providerKey: "tcgdex",
          queryKind: "languages",
        });
        const items = page.items.map((item) => ({ languageCode: item.value }));
        return c.json({ items, total: page.total, count: items.length, page: page.page, cache: page.cache });
      }

      const items = await services.listTcgdexLanguages();
      return c.json({ items, total: items.length, count: items.length });
    } catch (error) {
      return providerOptionErrorResponse(c, error);
    }
  });

  app.get("/tcgdex/series", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    try {
      if (typeof services.queryIntegrationOptions === "function") {
        const page = await services.queryIntegrationOptions({
          providerKey: "tcgdex",
          queryKind: "series",
          languageCode,
        });
        const items = page.items.map((item) => ({
          seriesId: item.value,
          name: item.label,
          logoUrl: metadataString(item.metadata.logoUrl),
        }));
        return c.json({ items, total: page.total, count: items.length, page: page.page, cache: page.cache });
      }

      const items = await services.listTcgdexSeries({ languageCode });
      return c.json({ items, total: items.length, count: items.length });
    } catch (error) {
      return providerOptionErrorResponse(c, error);
    }
  });

  app.get("/tcgdex/expansions", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    const seriesId = c.req.query("seriesId") ?? c.req.query("series");
    try {
      if (typeof services.queryIntegrationOptions === "function") {
        const page = await services.queryIntegrationOptions({
          providerKey: "tcgdex",
          queryKind: "expansions",
          languageCode,
          parentValue: seriesId,
        });
        const items = page.items.map((item) => ({
          expansionId: item.value,
          name: item.label,
          seriesId: item.parentValue,
          seriesName: metadataString(item.metadata.seriesName),
          logoUrl: metadataString(item.metadata.logoUrl),
          symbolUrl: metadataString(item.metadata.symbolUrl),
          cardCount: metadataNumber(item.metadata.cardCount),
          officialCardCount: metadataNumber(item.metadata.officialCardCount),
        }));
        return c.json({ items, total: page.total, count: items.length, page: page.page, cache: page.cache });
      }

      const items = await services.listTcgdexExpansions({ languageCode, seriesId });
      return c.json({ items, total: items.length, count: items.length });
    } catch (error) {
      return providerOptionErrorResponse(c, error);
    }
  });

  return app;
}

function providerOptionErrorResponse(c: Context<CatalogAuthoringEnv>, error: unknown) {
  if (error instanceof CatalogIntegrationRolloutControlError) {
    return c.json(rolloutControlErrorResponse(error), 403);
  }
  if (error instanceof CatalogProviderOptionQueryUnavailableError) {
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
        },
      },
      503,
    );
  }
  throw error;
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function metadataNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
