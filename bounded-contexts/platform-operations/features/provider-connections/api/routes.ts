import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { requireProviderConnectionsActor } from "./access";
import type { createProviderConnectionsRuntime } from "./runtime";

export function createProviderConnectionsRoutes(services: ReturnType<typeof createProviderConnectionsRuntime>) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.get("/", async (c) => {
    try {
      requireProviderConnectionsActor(c.get("actor"));
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
    return c.json(await services.read());
  });
  return app;
}
