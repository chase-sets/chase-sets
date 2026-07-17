import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import {
  upsertActiveAuthIdentityMembershipMirror,
  upsertRegisteredAuthIdentityUserMirror,
} from "../auth-support/identity-projection";
import { upsertPasswordCredential } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  getBootstrapContext,
  jsonWithMutationReceipts,
  readIdentityMutationConflict,
  type AuthApiApp,
} from "./support";
import { requireRegistrationAdmission } from "./registration-gates";

const registrationIpRateLimiter = createConfiguredInMemoryRateLimiter("auth.register.ip", {
  max: 3,
  windowMs: 60 * 60 * 1000,
});

export function registerRegistrationRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/register", async (c) => {
    const rateLimitDecision = registrationIpRateLimiter.check(publicClientRequestKey(c.req.raw));
    if (rateLimitDecision.limited) {
      return rateLimitExceededJsonResponse("auth.register.ip", rateLimitDecision);
    }

    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const admission = await requireRegistrationAdmission(services, email);
    if (!admission.ok) {
      return c.json(admission.failure.body, admission.failure.status);
    }

    const identityMutations = createIdentityMutations(c);
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
        foundersBetaAccessStartedAt: admission.foundersBetaAccessStartedAt,
      });
    } catch (error) {
      const conflict = readIdentityMutationConflict(error);
      if (conflict) {
        return c.json(conflict, 409);
      }

      throw error;
    }

    let passwordCredentialId: string | null = null;
    let passwordCredentialResult: Awaited<ReturnType<typeof identityMutations.enablePasswordCredential>> | null = null;
    if (body.password) {
      passwordCredentialId = createId("crd");
      passwordCredentialResult = await identityMutations.enablePasswordCredential({
        userId: identity.userId,
        credentialId: passwordCredentialId,
      });
      await upsertPasswordCredential(services.db, {
        credentialId: passwordCredentialId,
        userId: identity.userId,
        secretHash: await services.auth.hashPassword(String(body.password)),
      });
    }

    const registeredAt = new Date().toISOString();
    await upsertRegisteredAuthIdentityUserMirror(services.db, {
      userId: identity.userId,
      displayName: String(body.displayName ?? ""),
      givenName: body.givenName ? String(body.givenName) : "",
      familyName: body.familyName ? String(body.familyName) : "",
      email,
      authMethods: body.password ? ["password"] : [],
      passwordCredentialId,
      updatedAt: registeredAt,
    });

    await upsertActiveAuthIdentityMembershipMirror(services.db, {
      membershipId: identity.membershipId,
      userId: identity.userId,
      accountId: identity.accountId,
      roleKey: "owner",
      updatedAt: registeredAt,
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
      publishAuthenticationOutcome: true,
    });

    return jsonWithMutationReceipts(
      c,
      {
        ...authResult,
        accountId: identity.accountId,
      },
      201,
      [identity, passwordCredentialResult],
    );
  });
}
