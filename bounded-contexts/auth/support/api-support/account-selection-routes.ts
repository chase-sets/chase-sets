import { t } from "@chase-sets/localization";
import type { AuthMethod } from "../../features/sessions/domain/auth-flow";
import { consumeAccountSelectionToken, getAccountSelectionTokenByHash } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { getBootstrapContext, type AuthApiApp } from "./support";

export function registerAccountSelectionRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/account-selection/resolve", async (c) => {
    const body = await c.req.json();
    const selectionToken = String(body.selectionToken ?? "");
    const selection = await getAccountSelectionTokenByHash(services.db, services.auth.hashSecret(selectionToken));

    if (!selection) {
      return c.json(
        { error: t("auth.support.apiSupport.accountSelectionRoutes.account.selection.is.invalid.or.has") },
        401,
      );
    }

    const memberships = await services.identity.listActiveMembershipsForUser(selection.user_id);

    return c.json({
      userId: selection.user_id,
      memberships,
    });
  });

  app.post("/account-selection/complete", async (c) => {
    const body = await c.req.json();
    const selectionToken = String(body.selectionToken ?? "");
    const selection = await consumeAccountSelectionToken(services.db, services.auth.hashSecret(selectionToken));

    if (!selection) {
      return c.json(
        { error: t("auth.support.apiSupport.accountSelectionRoutes.account.selection.is.invalid.or.has.2") },
        401,
      );
    }

    const authResult = await startInteractiveAuth(services, {
      userId: selection.user_id,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: selection.authentication_method as AuthMethod,
      context: getBootstrapContext(c),
      publishAuthenticationOutcome: true,
    });

    if (authResult.type !== "session-started") {
      return c.json(
        { error: t("auth.support.apiSupport.accountSelectionRoutes.account.selection.could.not.be.completed") },
        400,
      );
    }

    return c.json(authResult);
  });
}
