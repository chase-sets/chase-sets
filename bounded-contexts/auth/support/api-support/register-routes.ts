import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { upsertActiveAuthIdentityMembershipMirror } from "../auth-support/identity-projection";
import { upsertPasswordCredential } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { createIdentityMutations, getBootstrapContext, readIdentityMutationConflict, type AuthApiApp } from "./support";

export function registerRegistrationRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/register", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const existingUser = await services.identity.getUserByEmail(email);
    if (existingUser) {
      return c.json({ error: t("auth.support.apiSupport.registerRoutes.a.user.already.exists.for.that") }, 409);
    }

    let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
    try {
      identity = await identityMutations.createPersonalIdentity({
        email,
        displayName: String(body.displayName ?? ""),
        givenName: body.givenName ? String(body.givenName) : undefined,
        familyName: body.familyName ? String(body.familyName) : undefined,
        consents: Array.isArray(body.consents) ? body.consents : undefined,
      });
    } catch (error) {
      const conflict = readIdentityMutationConflict(error);
      if (conflict) {
        return c.json(conflict, 409);
      }

      throw error;
    }

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

    await upsertActiveAuthIdentityMembershipMirror(services.db, {
      membershipId: identity.membershipId,
      userId: identity.userId,
      accountId: identity.accountId,
      roleKey: "owner",
      updatedAt: new Date().toISOString(),
    });

    const authResult = await startInteractiveAuth(services, {
      userId: identity.userId,
      accountId: identity.accountId,
      authenticationMethod: body.password ? "password" : "magic-link",
      context: getBootstrapContext(c),
      membershipsOverride: [
        {
          membershipId: identity.membershipId,
          accountId: identity.accountId,
          roleKey: "owner",
          status: "active",
          rolePermissions: AUTH_ROLE_PERMISSIONS.owner,
        },
      ],
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
