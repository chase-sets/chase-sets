import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type {
  CatalogIntegrationEngineServices,
  ProviderOptionQueryServices,
  SourceObservationReadServices,
} from "../runtime";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "../governance/catalog-integration-rollout-controls";
import { CatalogProviderOptionQueryUnavailableError } from "../providers/provider-option-query-cache";
import { CatalogProviderOptionQueryInvalidRequestError } from "../providers/provider-option-query-resolver";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

export type ProviderOptionRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  Pick<CatalogIntegrationEngineServices, "getCatalogIntegrationControlPlaneReadiness">;

export function providerOptionRoutes(services: ProviderOptionRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/integration-scopes", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    const { provider, source, language, productLineId, seriesId, setId, expansionId } = c.req.query();
    const items = await services.listIntegrationScopes({
      provider: provider ?? source,
      language,
      ...(productLineId ? { productLineId } : {}),
      ...(seriesId ? { seriesId } : {}),
      ...(expansionId ? { expansionId } : {}),
      setId: expansionId ?? setId,
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-options", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-option-query-read");
    if (permissionError) {
      return permissionError;
    }

    const providerKey = String(c.req.query("providerKey") ?? c.req.query("provider") ?? "tcgdex");
    const profileKey = c.req.query("profileKey");
    const ingestionUnitKey = c.req.query("ingestionUnitKey") ?? c.req.query("unitKey");
    const queryKind = String(c.req.query("queryKind") ?? c.req.query("kind") ?? "");
    const languageCode = c.req.query("languageCode") ?? c.req.query("language");
    const parentValue = c.req.query("parentValue") ?? c.req.query("seriesId") ?? c.req.query("series");
    const cursor = c.req.query("cursor");
    const limit = positiveIntegerQueryValue(c.req.query("limit"));
    const forceRefresh = c.req.query("forceRefresh") === "true";
    const cacheOnly = c.req.query("cacheOnly") === "true";

    try {
      if (typeof services.queryIntegrationOptions === "function") {
        const page = await services.queryIntegrationOptions({
          providerKey,
          profileKey,
          ingestionUnitKey,
          queryKind,
          languageCode,
          parentValue,
          cursor,
          limit,
          forceRefresh,
          ...(cacheOnly ? { cacheOnly } : {}),
        });
        return c.json(page);
      }

      const items = await services.listIntegrationOptions({
        providerKey,
        profileKey,
        ingestionUnitKey,
        queryKind,
        languageCode,
        parentValue,
      });
      return c.json({ items, total: items.length, count: items.length });
    } catch (error) {
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
      if (error instanceof CatalogProviderOptionQueryInvalidRequestError) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
            },
          },
          400,
        );
      }
      throw error;
    }
  });

  app.get("/integration-control-plane/readiness", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }

    const result = await services.getCatalogIntegrationControlPlaneReadiness();
    return c.json(result);
  });

  return app;
}

function positiveIntegerQueryValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
