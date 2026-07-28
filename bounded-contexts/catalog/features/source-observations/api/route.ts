import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "./providers/provider-integration-profile-store";
import type {
  BulkReviewJobServices,
  CatalogMergeCandidateServices,
  CatalogIntegrationEngineServices,
  ControlPlaneTelemetryServices,
  IntegrationJobServices,
  PromotionReapplyServices,
  ProviderOptionQueryServices,
  ProviderProfileAdminServices,
  SourceObservationReadServices,
  SourceObservationReviewServices,
} from "./runtime";
import { bulkReviewJobRoutes } from "./route-modules/bulk-review-job-routes";
import { controlPlaneTelemetryRoutes } from "./route-modules/control-plane-telemetry-routes";
import { integrationJobRoutes } from "./route-modules/integration-job-routes";
import { catalogMergeCandidateRoutes } from "./route-modules/catalog-merge-candidate-routes";
import { promotionReviewRoutes } from "./route-modules/promotion-review-routes";
import { providerOptionRoutes } from "./route-modules/provider-options-routes";
import { providerProfileRoutes } from "./route-modules/provider-profile-routes";
import { sourceObservationReadReviewRoutes } from "./route-modules/source-observation-review-routes";
import {
  buildCatalogIntegrationControlPlaneOverview,
  parseCatalogIntegrationControlPlaneOverviewAudience,
} from "./admin/admin-control-plane-overview";
import { listCatalogProviderProfileVersionReviews } from "./providers/provider-profile-review";
import { requireCatalogIntegrationControlPlanePermission } from "./admin/admin-control-plane-rbac";

export type SourceObservationRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  ProviderProfileAdminServices &
  CatalogIntegrationEngineServices &
  SourceObservationReviewServices &
  PromotionReapplyServices &
  BulkReviewJobServices &
  CatalogMergeCandidateServices &
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
  app.route("/", catalogMergeCandidateRoutes(services));
  app.route("/", controlPlaneTelemetryRoutes(services));
  app.route("/", sourceObservationReadReviewRoutes(services));
  app.get("/integration-control-plane/overview", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }

    // The daily import surface requests `?audience=daily` to skip the audit-lifecycle
    // projection it never renders; providers/governance/release omit the
    // parameter and receive the full overview, including the lifecycle timeline their
    // evidence slices cite.
    const audience = parseCatalogIntegrationControlPlaneOverviewAudience(c.req.query("audience"));
    const [readiness, profiles, recentJobs] = await Promise.all([
      services.getCatalogIntegrationControlPlaneReadiness(),
      profileVersions ? listCatalogProviderProfileVersionReviews(profileVersions) : Promise.resolve([]),
      services.listRecentIntegrationJobs({ context: c.get("context") }),
    ]);

    return c.json(
      buildCatalogIntegrationControlPlaneOverview({ readiness, profiles, activeJobs: recentJobs, audience }),
    );
  });

  return app;
}
