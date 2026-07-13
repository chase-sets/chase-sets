import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { CatalogServices } from "./services";
import { catalogAliasRoutes } from "../../features/alias-equivalence/api/route";
import { catalogAttentionQueueRoutes } from "../../features/attention-queue/api/route";
import { blueprintRoutes } from "../../features/blueprints/api/route";
import { catalogItemRoutes } from "../../features/catalog-items/api/route";
import { categoryRoutes } from "../../features/categories/api/route";
import { componentRoutes } from "../../features/components/api/route";
import { dimensionRoutes } from "../../features/dimensions/api/route";
import { displayTemplateRoutes } from "../../features/display-templates/api/route";
import { fieldRoutes } from "../../features/fields/api/route";
import { productContentRoutes } from "../../features/product-contents/api/route";
import { providerScopeMappingRoutes } from "../../features/provider-scope-mapping/api/route";
import { providerScopeDiscoveryRoutes } from "../../features/provider-scope-discovery/api/route";
import { referenceDataRoutes } from "../../features/reference-data/api/route";
import { catalogScopeRegistryRoutes } from "../../features/scope-registry/api/route";
import { sourceObservationRoutes } from "../../features/source-observations/api/route";

export type CatalogAuthoringEnv = {
  Variables: {
    actor: Readonly<{ permissions: readonly string[] }> | null;
    context: EventStoreContext;
  };
};

export function buildCatalogAuthoringApi(services: CatalogServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/bulk-authoring-jobs/active", async (c) => {
    const items = await services.authoringBulkJobs.listActive(c.get("context"));
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/bulk-authoring-jobs/:jobId", async (c) => {
    const job = await services.authoringBulkJobs.get(c.req.param("jobId"), c.get("context"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.support.authoringSupport.api.bulk.authoring.job.not.found"),
          },
        },
        404,
      );
    }

    return c.json(job);
  });

  app.get("/bulk-authoring-jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await services.authoringBulkJobs.get(jobId, c.get("context"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.support.authoringSupport.api.bulk.authoring.job.not.found"),
          },
        },
        404,
      );
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: catalogAuthoringStreamLimitKey(c.get("context")),
      loadEvents: async (afterSequence) =>
        (await services.authoringBulkJobs.listEvents(jobId, afterSequence, c.get("context"))).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.job,
        })),
      loadCurrentSnapshot: () => services.authoringBulkJobs.get(jobId, c.get("context")),
      waitForEvents: (_afterSequence, signal) => services.authoringBulkJobs.waitForEvents(jobId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });

  app.route("/dimensions", dimensionRoutes(services.dimensions, services.authoringBulkJobs));
  app.route("/display-templates", displayTemplateRoutes(services.displayTemplates));
  app.route("/fields", fieldRoutes(services.fields, services.authoringBulkJobs));
  app.route("/", referenceDataRoutes(services.referenceData, services.authoringBulkJobs));
  app.route("/components", componentRoutes(services.components, services.authoringBulkJobs));
  app.route("/blueprints", blueprintRoutes(services.blueprints, services.authoringBulkJobs));
  app.route("/categories", categoryRoutes(services.categories, services.authoringBulkJobs));
  app.route("/items", catalogItemRoutes(services.items, services.authoringBulkJobs));
  app.route("/product-contents", productContentRoutes(services.productContents));
  app.route(
    "/source-observations",
    sourceObservationRoutes(services.sourceObservations, services.providerIntegrationProfiles),
  );
  app.route("/alias-review", catalogAliasRoutes(services.catalogAliases));
  app.route("/attention-queue", catalogAttentionQueueRoutes(services.attentionQueue));
  app.route("/provider-scope-mappings", providerScopeMappingRoutes(services.providerScopeMappings));
  app.route("/scope-records", catalogScopeRegistryRoutes(services.scopeRegistry));
  app.route("/provider-scope-discovery", providerScopeDiscoveryRoutes(services.providerScopeDiscovery));

  return app;
}

function catalogAuthoringStreamLimitKey(context: CatalogAuthoringEnv["Variables"]["context"]) {
  return `account:${context.audit.forAccountId}:user:${context.audit.performedByUserId}`;
}
