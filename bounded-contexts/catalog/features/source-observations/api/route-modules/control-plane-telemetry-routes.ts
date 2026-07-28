import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { ControlPlaneTelemetryServices } from "../runtime";
import {
  isCatalogControlPlaneTelemetryEventName,
  type CatalogControlPlaneTelemetryEventInput,
} from "../governance/catalog-integration-observability";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

export type ControlPlaneTelemetryRouteServices = ControlPlaneTelemetryServices;

export function controlPlaneTelemetryRoutes(services: ControlPlaneTelemetryRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/control-plane-events", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-control-plane-read");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const event = telemetryEventFromBody(body);
    if (!event) {
      return c.json(
        {
          error: {
            code: "invalid_control_plane_event",
            message: t("catalog.features.sourceObservations.api.route.telemetry.invalid.event"),
          },
        },
        400,
      );
    }

    services.recordControlPlaneTelemetry(event);

    return c.json({ status: "recorded" }, 202);
  });

  return app;
}

function telemetryEventFromBody(body: Record<string, unknown>): CatalogControlPlaneTelemetryEventInput | null {
  const eventName = body.eventName;
  if (!isCatalogControlPlaneTelemetryEventName(eventName)) {
    return null;
  }

  return {
    eventName,
    providerKey: stringValue(body.providerKey),
    unitKey: stringValue(body.unitKey),
    scopeId: stringValue(body.scopeId),
    profileRef: stringValue(body.profileRef),
    jobRefState: stringValue(body.jobRefState) as CatalogControlPlaneTelemetryEventInput["jobRefState"],
    observationStatus: stringValue(
      body.observationStatus,
    ) as CatalogControlPlaneTelemetryEventInput["observationStatus"],
    observationCount: numberValue(body.observationCount),
    promotionResult: stringValue(body.promotionResult) as CatalogControlPlaneTelemetryEventInput["promotionResult"],
    promotionCount: numberValue(body.promotionCount),
    blockerCategory: stringValue(body.blockerCategory) as CatalogControlPlaneTelemetryEventInput["blockerCategory"],
    detourTarget: stringValue(body.detourTarget) as CatalogControlPlaneTelemetryEventInput["detourTarget"],
    detourOutcome: stringValue(body.detourOutcome) as CatalogControlPlaneTelemetryEventInput["detourOutcome"],
    roleBucket: stringValue(body.roleBucket) as CatalogControlPlaneTelemetryEventInput["roleBucket"],
    readModelFreshness: stringValue(body.readModelFreshness),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
