import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import type {
  BulkReviewJobServices,
  CatalogIntegrationEngineServices,
  ControlPlaneTelemetryServices,
  IntegrationJobServices,
  PromotionReapplyServices,
  ProviderOptionQueryServices,
  ProviderProfileAdminServices,
  SourceObservationReadServices,
  SourceObservationReviewServices,
} from "./runtime";
import { bulkReviewJobRoutes } from "./bulk-review-job-routes";
import { controlPlaneTelemetryRoutes } from "./control-plane-telemetry-routes";
import { integrationJobRoutes } from "./integration-job-routes";
import { promotionReviewRoutes } from "./promotion-review-routes";
import { providerOptionRoutes } from "./provider-options-routes";
import { providerProfileRoutes } from "./provider-profile-routes";
import { sourceObservationReadReviewRoutes } from "./source-observation-review-routes";
import { buildCatalogIntegrationControlPlaneOverview } from "./admin-control-plane-overview";
import { listCatalogProviderProfileVersionReviews } from "./provider-profile-review";
import { requireCatalogIntegrationControlPlanePermission } from "./admin-control-plane-rbac";

export type SourceObservationRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  ProviderProfileAdminServices &
  CatalogIntegrationEngineServices &
  SourceObservationReviewServices &
  PromotionReapplyServices &
  BulkReviewJobServices &
  IntegrationJobServices &
  ControlPlaneTelemetryServices;

export function sourceObservationRoutes(
  services: SourceObservationRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.route("/", providerOptionRoutes(services));
  app.route("/", providerProfileRoutes(services, profileVersions));
  app.route("/", promotionReviewRoutes(services));
  app.route("/", bulkReviewJobRoutes(services));
  app.route("/", integrationJobRoutes(services));
  app.route("/", controlPlaneTelemetryRoutes(services));
  app.route("/", sourceObservationReadReviewRoutes(services));
  app.get("/integration-control-plane/overview", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }

    const [readiness, profiles, activeJobs] = await Promise.all([
      services.getCatalogIntegrationControlPlaneReadiness(),
      profileVersions ? listCatalogProviderProfileVersionReviews(profileVersions) : Promise.resolve([]),
      services.listActiveIntegrationJobs({ context: c.get("context") }),
    ]);

    return c.json(buildCatalogIntegrationControlPlaneOverview({ readiness, profiles, activeJobs }));
  });

  return app;
}
