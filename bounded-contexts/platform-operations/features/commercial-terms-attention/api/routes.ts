import { Hono } from "hono";
import type { PlatformOperationsApiEnv } from "../../../api";
import type { createCommercialTermsAttentionRuntime } from "./runtime";

export function createCommercialTermsAttentionRoutes(
  services: ReturnType<typeof createCommercialTermsAttentionRuntime>,
) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    if (!actor.permissions.includes("platform-policy.view")) {
      return c.json({ error: { code: "authorization_forbidden" } }, 403);
    }
    return c.json({ items: await services.list() });
  });

  return app;
}
