import { sessionRoutes } from "../sessions/route";
import { revokeSession, type AuthServices } from "../services";
import {
  createPermissionGuard,
  getRequiredContext,
  type AuthApiApp,
} from "./support";

export function registerSessionApiRoutes(
  app: AuthApiApp,
  services: AuthServices,
) {
  app.get("/session", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    return c.json({ actor });
  });

  app.post("/sign-out", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const result = await revokeSession(services, {
      sessionId: actor.sessionId,
      context: getRequiredContext(c),
    });

    return c.json(result);
  });

  const securityManageGuard = createPermissionGuard("security.manage");
  app.use("/sessions", securityManageGuard);
  app.use("/sessions/*", securityManageGuard);
  app.route("/sessions", sessionRoutes(services.sessions));
}
