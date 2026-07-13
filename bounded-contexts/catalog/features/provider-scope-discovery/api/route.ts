import { Hono } from "hono";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { ProviderScopeDiscoveryServices } from "./runtime";

// Provider scope refresh schedule surface: visible to catalog viewers,
// pausable/resumable/runnable by catalog managers. The schedule itself is
// config-driven (provider-refresh-cadence.ts); these routes expose the
// operational state and the operator pause control the providers surface
// renders.
export function providerScopeDiscoveryRoutes(services: ProviderScopeDiscoveryServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/refresh-schedule", async (c) => {
    const permissionError = requirePermission(c, "catalog.view");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listRefreshSchedules();
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/refresh-schedule/:providerKey/pause", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const body = await optionalJsonBody(c);
    const schedule = await services.setRefreshPaused({
      providerKey: c.req.param("providerKey"),
      paused: true,
      actor: actorLabel(c),
      reason: typeof body?.reason === "string" ? body.reason : null,
    });
    if (!schedule) {
      return providerNotFound(c);
    }
    return c.json(schedule);
  });

  app.post("/refresh-schedule/:providerKey/resume", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const schedule = await services.setRefreshPaused({
      providerKey: c.req.param("providerKey"),
      paused: false,
      actor: actorLabel(c),
    });
    if (!schedule) {
      return providerNotFound(c);
    }
    return c.json(schedule);
  });

  app.post("/refresh-schedule/:providerKey/run", async (c) => {
    const permissionError = requirePermission(c, "catalog.manage");
    if (permissionError) {
      return permissionError;
    }

    const result = await services.runProviderRefreshNow({
      providerKey: c.req.param("providerKey"),
      context: c.get("context"),
      triggeredBy: actorLabel(c),
    });
    return c.json(result, result.status === "failed" ? 502 : 200);
  });

  app.get("/scope-observations", async (c) => {
    const permissionError = requirePermission(c, "catalog.view");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listScopeObservations({
      providerKey: c.req.query("providerKey"),
      queryKind: c.req.query("queryKind"),
      limit: positiveIntegerQueryValue(c.req.query("limit")) ?? undefined,
    });
    return c.json({ items, total: items.length, count: items.length });
  });

  return app;
}

function requirePermission(c: Context<CatalogAuthoringEnv>, permission: "catalog.view" | "catalog.manage") {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }
  if (!actor.permissions.includes(permission)) {
    return c.json(forbiddenResponse(), 403);
  }
  return null;
}

function providerNotFound(c: Context<CatalogAuthoringEnv>) {
  return c.json(
    {
      error: {
        code: "provider_refresh_schedule_not_found",
        message: "No refresh schedule exists for that provider.",
      },
    },
    404,
  );
}

function actorLabel(c: Context<CatalogAuthoringEnv>): string {
  return `user:${c.get("context").audit.performedByUserId}`;
}

function positiveIntegerQueryValue(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function optionalJsonBody(c: Context<CatalogAuthoringEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
