import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { redactCatalogIntegrationProviderData } from "./catalog-integration-data-governance";
import type { SourceObservationReadServices, SourceObservationReviewServices } from "./runtime";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "./catalog-integration-rollout-controls";
import { requireCatalogIntegrationControlPlanePermission } from "./admin-control-plane-rbac";

export type SourceObservationReadReviewRouteServices = SourceObservationReadServices & SourceObservationReviewServices;

export function sourceObservationReadReviewRoutes(services: SourceObservationReadReviewRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-read");
    if (permissionError) {
      return permissionError;
    }

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

  app.get("/:id", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-read");
    if (permissionError) {
      return permissionError;
    }

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

    return c.json({
      ...observation,
      source_payload: redactCatalogIntegrationProviderData(observation.source_payload),
    });
  });

  app.post("/:id/promote", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-review");
    if (permissionError) {
      return permissionError;
    }

    let result;
    try {
      result = await services.promoteObservation({
        observationId: c.req.param("id"),
        context: c.get("context"),
      });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }

    return c.json(result);
  });

  app.post("/:id/reject", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-review");
    if (permissionError) {
      return permissionError;
    }

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
