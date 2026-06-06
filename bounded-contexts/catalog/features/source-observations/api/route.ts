import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import type {
  BulkReviewJobServices,
  CatalogIntegrationEngineServices,
  IntegrationJobServices,
  PromotionReapplyServices,
  ProviderOptionQueryServices,
  ProviderProfileAdminServices,
  SourceObservationReadServices,
  SourceObservationReviewServices,
} from "./runtime";
import { bulkReviewJobRoutes } from "./bulk-review-job-routes";
import { integrationJobRoutes } from "./integration-job-routes";
import { promotionReviewRoutes } from "./promotion-review-routes";
import { providerCompatibilityRoutes } from "./provider-compatibility-routes";
import { providerOptionRoutes } from "./provider-options-routes";
import { providerProfileRoutes } from "./provider-profile-routes";
import { sourceObservationReadReviewRoutes } from "./source-observation-review-routes";

export type SourceObservationRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  ProviderProfileAdminServices &
  CatalogIntegrationEngineServices &
  SourceObservationReviewServices &
  PromotionReapplyServices &
  BulkReviewJobServices &
  IntegrationJobServices;

export function sourceObservationRoutes(
  services: SourceObservationRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.route("/", providerOptionRoutes(services));
  app.route("/", providerProfileRoutes(services, profileVersions));
  app.route("/", providerCompatibilityRoutes(services));
  app.route("/", promotionReviewRoutes(services));
  app.route("/", bulkReviewJobRoutes(services));
  app.route("/", integrationJobRoutes(services));
  app.route("/", sourceObservationReadReviewRoutes(services));

  return app;
}
