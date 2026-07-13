import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { IntegrationJobServices, SourceObservationIntegrationJobAction } from "./runtime";
import { isSourceObservationIntegrationJobLifecycleCommandError } from "./runtime";
import {
  isIntegrationJobValidationError,
  parseCatalogSyncScope,
  parseIntegrationJobScope,
  parseReapplyProfileMode,
  streamIntegrationJobEvents,
} from "./route-helpers";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "./catalog-integration-rollout-controls";
import { requireCatalogIntegrationControlPlanePermission } from "./admin-control-plane-rbac";

export type IntegrationJobRouteServices = IntegrationJobServices;

export function integrationJobRoutes(services: IntegrationJobRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/integration-jobs", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      scope?: unknown;
      reapplyProfileMode?: unknown;
    };
    const actionValue = String(body.action ?? "");

    if (actionValue !== "import" && actionValue !== "reapply") {
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
    const action: SourceObservationIntegrationJobAction = actionValue;

    const jobInput = {
      action,
      scope: parseIntegrationJobScope(body.scope),
      ...(action === "reapply" ? { reapplyProfileMode: parseReapplyProfileMode(body.reapplyProfileMode) } : {}),
      context: c.get("context"),
    };

    let job;
    try {
      job = await services.enqueueIntegrationJob(jobInput);
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
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

  app.post("/integration-jobs/preview", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      scope?: unknown;
    };
    const actionValue = String(body.action ?? "import");
    if (actionValue !== "import") {
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

    try {
      const preview = await services.previewIntegrationImport({
        scope: parseIntegrationJobScope(body.scope),
        context: c.get("context"),
      });
      return c.json(preview);
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
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
  });

  app.post("/catalog-sync-scope/preview", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };

    try {
      const preview = await services.previewCatalogSyncScope({
        scope: parseCatalogSyncScope(body.scope),
        context: c.get("context"),
      });
      return c.json(preview);
    } catch (error) {
      if (!isCatalogSyncScopeValidationError(error)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_scope",
            message: error instanceof Error ? error.message : "Catalog sync scope is invalid.",
          },
        },
        400,
      );
    }
  });

  app.post("/catalog-sync-scope/state", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };

    try {
      const units = await services.getCatalogScopeSyncState({
        scope: parseCatalogSyncScope(body.scope),
        context: c.get("context"),
      });
      return c.json({ items: units, total: units.length, count: units.length });
    } catch (error) {
      if (!isCatalogSyncScopeValidationError(error)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_scope",
            message: error instanceof Error ? error.message : "Catalog sync scope is invalid.",
          },
        },
        400,
      );
    }
  });

  app.post("/catalog-sync-scope/runs", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };

    try {
      const run = await services.enqueueCatalogSyncRun({
        scope: parseCatalogSyncScope(body.scope),
        context: c.get("context"),
      });
      return c.json(run, 202);
    } catch (error) {
      if (!isCatalogSyncScopeValidationError(error)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_scope",
            message: error instanceof Error ? error.message : "Catalog sync scope is invalid.",
          },
        },
        400,
      );
    }
  });

  app.get("/catalog-sync-scope/runs/:syncRunId", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const run = await services.getCatalogSyncRun({
      syncRunId: c.req.param("syncRunId"),
      context: c.get("context"),
    });
    if (!run) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.catalog.sync.run.not.found"),
          },
        },
        404,
      );
    }

    return c.json(run);
  });

  app.get("/integration-jobs/active", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listActiveIntegrationJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/integration-jobs/:jobId/retry", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-write");
    if (permissionError) {
      return permissionError;
    }

    try {
      const job = await services.retryIntegrationJob({
        jobId: c.req.param("jobId"),
        context: c.get("context"),
      });
      return c.json(job, 202);
    } catch (error) {
      return integrationJobLifecycleCommandErrorResponse(c, error);
    }
  });

  app.post("/integration-jobs/:jobId/resume", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-write");
    if (permissionError) {
      return permissionError;
    }

    try {
      const job = await services.resumeIntegrationJob({
        jobId: c.req.param("jobId"),
        context: c.get("context"),
      });
      return c.json(job, 202);
    } catch (error) {
      return integrationJobLifecycleCommandErrorResponse(c, error);
    }
  });

  app.post("/integration-jobs/:jobId/cancel", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-write");
    if (permissionError) {
      return permissionError;
    }

    try {
      const job = await services.cancelIntegrationJob({
        jobId: c.req.param("jobId"),
        context: c.get("context"),
      });
      return c.json(job, 202);
    } catch (error) {
      return integrationJobLifecycleCommandErrorResponse(c, error);
    }
  });

  app.get("/integration-jobs/:jobId", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

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

function isCatalogSyncScopeValidationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith("Catalog sync scope") ||
      error.message.startsWith("Provider hint") ||
      error.message.includes("Catalog sync scope reference.kind"))
  );
}

function integrationJobLifecycleCommandErrorResponse(c: Context<CatalogAuthoringEnv>, error: unknown) {
  if (!isSourceObservationIntegrationJobLifecycleCommandError(error)) {
    throw error;
  }

  if (error.code === "job_not_found") {
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

  return c.json(
    {
      error: {
        code: error.code,
        message: t("catalog.features.sourceObservations.api.route.integration.job.lifecycle.unsupported"),
      },
    },
    409,
  );
}
