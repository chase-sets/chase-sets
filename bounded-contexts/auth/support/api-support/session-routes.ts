import { t } from "@chase-sets/localization";
import { sessionRoutes } from "../../features/sessions/api/route";
import { revokeSession, type AuthServices } from "../runtime-support/services";
import { resolveActorFromRequest } from "../runtime-support/runtime";
import { createPermissionGuard, getRequiredContext, type AuthApiApp } from "./support";

export function registerSessionApiRoutes(app: AuthApiApp, services: AuthServices) {
  app.get("/session", async (c) => {
    // The host resolves `c.var.actor` before the read-consistency middleware
    // waits on this route's declared projection dependencies (`identity_sessions`,
    // the membership tables and `auth_identity_users`). That pre-wait actor may
    // therefore carry permissions computed from a stale Identity user
    // projection, so the session (or guest checkout) actor is resolved again
    // here, after the wait, and the pre-wait value is never returned in its
    // place. A failed fresh resolution (expired or revoked session, inactive or
    // missing membership) fails closed instead of falling back to the cached
    // pre-wait success.
    //
    // Linked-platform (UCP OAuth) actors are the exception: their scope-attenuated
    // permissions come from the host resolver's authorization lookup, which this
    // route does not hold, so re-resolving them here could only substitute
    // role permissions for the scoped grant. They keep the host-resolved actor.
    const preWaitActor = c.var.actor;
    const actor = preWaitActor?.agentGrant ? preWaitActor : await resolveActorFromRequest(services, c.req.raw);
    if (!actor) {
      return c.json({ error: t("auth.support.apiSupport.sessionRoutes.authentication.required") }, 401);
    }

    return c.json({ actor });
  });

  app.post("/sign-out", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: t("auth.support.apiSupport.sessionRoutes.authentication.required.2") }, 401);
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
