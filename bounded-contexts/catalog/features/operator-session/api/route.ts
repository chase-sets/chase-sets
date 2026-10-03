import { Hono } from "hono";
import { resolveRecentAuthenticationStatus, type ResolvedActor } from "@chase-sets/auth-context";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import type { createOperatorSessionGrants } from "./grants";

type Services = ReturnType<typeof createOperatorSessionGrants>;
export function operatorSessionAdminRoutes(services: Services) {
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const actor = c.get("actor");
    if (!actor) return c.json(authenticationRequiredResponse(), 401);
    if (
      actor.roleKey !== "platform-admin" ||
      !actor.permissions.includes(c.req.method === "GET" ? "catalog.view" : "catalog.manage")
    )
      return c.json(forbiddenResponse(), 403);
    if (c.req.method !== "GET") {
      if (
        c.req.header("origin") !== resolvePublicRequestOrigin(c.req.raw) ||
        c.req.header("sec-fetch-site") === "cross-site"
      )
        return c.json({ code: "forbidden" }, 403);
      if (!resolveRecentAuthenticationStatus(actor, { maxAgeMinutes: 10 }).recentlyAuthenticated)
        return c.json({ code: "step_up_required" }, 400);
    }
    await next();
  });
  app.get("/", (c) => services.execute("metadata", c.req.raw, c.get("actor")));
  app.post("/grant", (c) => services.execute("mint", c.req.raw, c.get("actor")));
  app.delete("/", (c) => services.execute("disconnect", c.req.raw, c.get("actor")));
  return app;
}

export function operatorSessionPublicRoutes(services: Services) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.put("/tcgplayer", (c) => services.execute("push", c.req.raw));
  app.delete("/grant", (c) => services.execute("unpair", c.req.raw));
  return app;
}
