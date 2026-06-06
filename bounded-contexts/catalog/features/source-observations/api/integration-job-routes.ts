import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { IntegrationJobServices } from "./runtime";
import { isIntegrationJobValidationError, parseIntegrationJobScope, streamIntegrationJobEvents } from "./route-helpers";

export type IntegrationJobRouteServices = IntegrationJobServices;

export function integrationJobRoutes(services: IntegrationJobRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/integration-jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      scope?: unknown;
    };
    const action = String(body.action ?? "");

    if (action !== "import" && action !== "reapply") {
      return c.json(
        {
          error: {
            code: "invalid_action",
            message: t("catalog.features.sourceObservations.api.route.integration.job.invalid.action"),
          },
        },
        400,
      );
    }

    let job;
    try {
      job = await services.enqueueIntegrationJob({
        action,
        scope: parseIntegrationJobScope(body.scope),
        context: c.get("context"),
      });
    } catch (error) {
      if (!isIntegrationJobValidationError(error)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_scope",
            message: error.message,
          },
        },
        400,
      );
    }

    return c.json(job, 202);
  });

  app.get("/integration-jobs/active", async (c) => {
    const items = await services.listActiveIntegrationJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-jobs/:jobId", async (c) => {
    const job = await services.getIntegrationJob(c.req.param("jobId"), c.get("context"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.integration.job.not.found"),
          },
        },
        404,
      );
    }

    return c.json(job);
  });

  app.get("/integration-jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await services.getIntegrationJob(jobId, c.get("context"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.integration.job.not.found"),
          },
        },
        404,
      );
    }

    return streamIntegrationJobEvents(services, jobId, c.req.raw, c.get("context"));
  });

  return app;
}
