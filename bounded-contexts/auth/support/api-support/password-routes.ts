import { getPasswordCredentialByUserId } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { getBootstrapContext, type AuthApiApp } from "./support";

export function registerPasswordRoutes(
  app: AuthApiApp,
  services: AuthServices,
) {
  app.post("/password-sign-in", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const user = await services.identity.getUserByEmail(email);
    if (!user) {
      return c.json({ error: "Invalid email or password." }, 401);
    }

    const passwordCredential = await getPasswordCredentialByUserId(
      services.db,
      user.user_id,
    );
    if (
      !passwordCredential ||
      !services.auth.verifySecret(
        String(body.password ?? ""),
        passwordCredential.secret_hash,
      )
    ) {
      return c.json({ error: "Invalid email or password." }, 401);
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "password",
      context: getBootstrapContext(c),
    });

    return c.json(authResult);
  });
}
