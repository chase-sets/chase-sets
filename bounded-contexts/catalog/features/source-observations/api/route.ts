import { Hono } from "hono";
import type { ProviderScopeDiscoveryServices } from "../../provider-scope-discovery/api/runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "./providers/provider-integration-profile-store";
import type {
  BulkReviewJobServices,
  CatalogMergeCandidateBulkJobServices,
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
  primaryWorkbenchSurfaceRoutes,
  type PrimaryWorkbenchSurfaceRouteDeps,
} from "./route-modules/primary-workbench-surface-routes";
import { parseCatalogIntegrationControlPlaneOverviewAudience } from "./admin/admin-control-plane-overview";
import { loadCatalogIntegrationControlPlaneOverview } from "./route-modules/control-plane-overview-load";
import { requireCatalogIntegrationControlPlanePermission } from "./admin/admin-control-plane-rbac";

export type SourceObservationRouteServices = Partial<ProviderSendWindowServices> &
  SourceObservationReadServices &
  ProviderOptionQueryServices &
  ProviderProfileAdminServices &
  CatalogIntegrationEngineServices &
  SourceObservationReviewServices &
  PromotionReapplyServices &
  BulkReviewJobServices &
  CatalogMergeCandidateBulkJobServices &
  CatalogMergeCandidateServices &
  IntegrationJobServices &
  ControlPlaneTelemetryServices;

export function sourceObservationRoutes(
  services: SourceObservationRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
  readCountSpend?: () => Promise<readonly import("../../scope-sync-batches/domain/count-acquisition").CountSpend[]>,
  listRefreshSchedules?: ProviderScopeDiscoveryServices["listRefreshSchedules"],
  getScopeRecord?: PrimaryWorkbenchSurfaceRouteDeps["getScopeRecord"],
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.route("/", providerOptionRoutes(services));
  app.route("/", providerProfileRoutes(services, profileVersions));
  app.route("/", promotionReviewRoutes(services));
  app.route("/", bulkReviewJobRoutes(services));
  app.route("/", integrationJobRoutes(services));
  app.route("/", catalogMergeCandidateRoutes(services));
  app.route("/", controlPlaneTelemetryRoutes(services));
  app.route(
    "/",
    primaryWorkbenchSurfaceRoutes({ services, profileVersions, readCountSpend, listRefreshSchedules, getScopeRecord }),
  );
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
    const providerSendWindow = (await services.getProviderSendWindow?.()) ?? { state: "unavailable" as const };
    if (c.req.query("provider-send-window") === "true") {
      return c.json({ providerSendWindow }, providerSendWindow.state === "unavailable" ? 503 : 200);
    }
    const audience = parseCatalogIntegrationControlPlaneOverviewAudience(c.req.query("audience"));

    return c.json(
      await loadCatalogIntegrationControlPlaneOverview(
        { services, profileVersions, readCountSpend },
        { context: c.get("context"), audience, providerSendWindow },
      ),
    );
  });

  return app;
}
import type { ProviderSendWindowServices } from "./source-observation-runtime-contracts";
