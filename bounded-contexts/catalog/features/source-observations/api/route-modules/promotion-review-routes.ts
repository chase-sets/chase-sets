import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { CatalogIntegrationEngineServices, PromotionReapplyServices } from "../runtime";
import { parseObservationIds, parsePromoteAsDraft, parsePromotionScope, parseValidationAfter } from "./route-helpers";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

export type PromotionReviewRouteServices = Pick<
  PromotionReapplyServices,
  "previewPromoteObservations" | "previewPromoteObservationScope" | "previewReapplyObservationScope"
> &
  Pick<CatalogIntegrationEngineServices, "previewReplayReapplyImpact">;

export function promotionReviewRoutes(services: PromotionReviewRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/bulk-promote/preview", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "promotion-impact-preview");
    if (permissionError) {
      return permissionError;
    }

    // Read-only: counts, content fingerprint, and per-observation validation
    // diagnostics over a bounded page. Nothing is provisioned or executed.
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      promoteAsDraft?: unknown;
      validationAfter?: unknown;
    };
    const observationIds = parseObservationIds(body.observationIds);
    const promoteAsDraft = parsePromoteAsDraft(body.promoteAsDraft);
    const validationAfter = parseValidationAfter(body.validationAfter);
    const result =
      observationIds.length > 0
        ? await services.previewPromoteObservations({ observationIds, promoteAsDraft, validationAfter })
        : await services.previewPromoteObservationScope({
            scope: parsePromotionScope(body.scope),
            promoteAsDraft,
            validationAfter,
          });

    return c.json(result);
  });

  app.post("/reapply/preview", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "promotion-impact-preview");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };
    const result = await services.previewReapplyObservationScope({
      scope: parsePromotionScope(body.scope),
    });

    return c.json(result);
  });

  app.post("/reapply/impact", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "promotion-impact-preview");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      providerKey?: unknown;
      profileVersion?: unknown;
      scope?: unknown;
    };
    const providerKey = String(body.providerKey ?? "").trim();
    const profileVersion = String(body.profileVersion ?? "").trim();

    if (!providerKey || !profileVersion) {
      return c.json(
        {
          error: {
            code: "profile_version_required",
            message: t("catalog.features.sourceObservations.api.route.impact.profile.version.required"),
          },
        },
        400,
      );
    }

    const result = await services.previewReplayReapplyImpact({
      providerKey,
      profileVersion,
      scope: parsePromotionScope(body.scope),
      context: c.get("context"),
    });

    return c.json(result);
  });

  return app;
}
