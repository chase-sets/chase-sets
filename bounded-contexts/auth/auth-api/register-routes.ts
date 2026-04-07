import { createId } from "@chase-sets/primitives/typed-ids";
import { upsertPasswordCredential } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../services";
import {
  createIdentityMutations,
  getBootstrapContext,
  type AuthApiApp,
} from "./support";

export function registerRegistrationRoutes(
  app: AuthApiApp,
  services: AuthServices,
) {
  app.post("/register", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const existingUser = await services.identity.getUserByEmail(email);
    if (existingUser) {
      return c.json({ error: "A user already exists for that email." }, 409);
    }

    const identity = await identityMutations.createPersonalIdentity({
      email,
      displayName: String(body.displayName ?? ""),
      givenName: body.givenName ? String(body.givenName) : undefined,
      familyName: body.familyName ? String(body.familyName) : undefined,
      consents: Array.isArray(body.consents) ? body.consents : undefined,
    });

    if (body.password) {
      const credentialId = createId("crd");
      await identityMutations.enablePasswordCredential({
        userId: identity.userId,
        credentialId,
      });
      await upsertPasswordCredential(services.db, {
        credentialId,
        userId: identity.userId,
        secretHash: services.auth.hashSecret(String(body.password)),
      });
    }

    const authResult = await startInteractiveAuth(services, {
      userId: identity.userId,
      accountId: identity.accountId,
      authenticationMethod: body.password ? "password" : "magic-link",
      context: getBootstrapContext(c),
    });

    return c.json(
      {
        ...authResult,
        accountId: identity.accountId,
      },
      201,
    );
  });
}
