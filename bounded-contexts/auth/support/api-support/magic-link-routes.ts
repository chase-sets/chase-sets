import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import { authSecurityLifetimesOf, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { consumeMagicLinkToken, insertMagicLinkToken } from "../auth-support/store";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  jsonWithMutationReceipts,
  readIdentityMutationConflict,
  type AuthApiApp,
} from "./support";
import { requireRegistrationAdmission } from "./registration-gates";

function buildPublicOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
}

function safeLandingPath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/sign-in/magic";
}

function safeReturnTo(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

const magicLinkRequestIdentifierRateLimiter = createConfiguredInMemoryRateLimiter(
  "auth.magic-link.request.identifier",
  {
    max: 3,
    windowMs: 60 * 60 * 1000,
  },
);

const magicLinkRequestIpRateLimiter = createConfiguredInMemoryRateLimiter("auth.magic-link.request.ip", {
  max: 10,
  windowMs: 60 * 60 * 1000,
});

const magicLinkConsumeIpRateLimiter = createConfiguredInMemoryRateLimiter("auth.magic-link.consume.ip", {
  max: 10,
  windowMs: 10 * 60 * 1000,
});

const magicLinkConsumeTokenRateLimiter = createConfiguredInMemoryRateLimiter("auth.magic-link.consume.token", {
  max: 5,
  windowMs: 10 * 60 * 1000,
});

export function registerMagicLinkRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/magic-link/request", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const identifierDecision = magicLinkRequestIdentifierRateLimiter.check(`email:${email || "unknown"}`);
    if (identifierDecision.limited) {
      return rateLimitExceededJsonResponse("auth.magic-link.request.identifier", identifierDecision);
    }
    const ipDecision = magicLinkRequestIpRateLimiter.check(publicClientRequestKey(c.req.raw));
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse("auth.magic-link.request.ip", ipDecision);
    }

    const user = await services.identity.getUserByEmail(email);
    if (!user) {
      const admission = await requireRegistrationAdmission(services, email);
      if (!admission.ok) {
        return c.json(admission.failure.body, admission.failure.status);
      }
    }

    const tokenId = createId("cmd");
    const token = services.auth.issueOpaqueToken("magic");
    const expiresAt = createExpiryTimestamp(authSecurityLifetimesOf(services).magicLinkTtlMs);

    await insertMagicLinkToken(services.db, {
      tokenId,
      userId: user?.user_id ?? null,
      email,
      tokenHash: services.auth.hashSecret(token),
      deliveryToken: token,
      expiresAt,
    });

    await services.eventStore.appendToStream({
      streamId: `auth.magic-link-${tokenId}`,
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "auth.magic-link.requested",
          payload: {
            tokenId,
            userId: user?.user_id ?? null,
            email,
            expiresAt,
            origin: buildPublicOrigin(c.req.raw),
            landingPath: safeLandingPath(body.landingPath),
            returnTo: safeReturnTo(body.returnTo),
          },
        },
      ],
      context: getBootstrapContext(c),
    });

    return c.json({ tokenId, expiresAt });
  });

  app.post("/magic-link/consume", async (c) => {
    const body = await c.req.json();
    const ipDecision = magicLinkConsumeIpRateLimiter.check(publicClientRequestKey(c.req.raw));
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse("auth.magic-link.consume.ip", ipDecision);
    }
    const tokenHash = services.auth.hashSecret(String(body.token ?? ""));
    const tokenDecision = magicLinkConsumeTokenRateLimiter.check(tokenHash);
    if (tokenDecision.limited) {
      return rateLimitExceededJsonResponse("auth.magic-link.consume.token", tokenDecision);
    }

    const identityMutations = createIdentityMutations(c);
    const record = await consumeMagicLinkToken(services.db, tokenHash);
    if (!record) {
      return c.json({ error: t("auth.support.apiSupport.magicLinkRoutes.magic.link.is.invalid.or.has") }, 401);
    }

    let user = record.user_id
      ? await services.identity.getUser(record.user_id)
      : await services.identity.getUserByEmail(record.email);

    if (!user) {
      const admission = await requireRegistrationAdmission(services, record.email);
      if (!admission.ok) {
        return c.json(admission.failure.body, admission.failure.status);
      }

      let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
      try {
        identity = await identityMutations.createPersonalIdentity({
          email: record.email,
          displayName: createOwnedUserDisplayName(record.email),
          foundersBetaAccessStartedAt: admission.invitationId ? new Date().toISOString() : undefined,
        });
      } catch (error) {
        const conflict = readIdentityMutationConflict(error);
        if (conflict) {
          return c.json(conflict, 409);
        }

        throw error;
      }
      const verifiedEmail = await identityMutations.verifyEmailContactMethod({
        userId: identity.userId,
        email: record.email,
      });
      const authResult = await startInteractiveAuth(services, {
        userId: identity.userId,
        accountId: identity.accountId,
        authenticationMethod: "magic-link",
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

      return jsonWithMutationReceipts(c, authResult, 200, [identity, verifiedEmail]);
    }

    const verifiedEmail = await identityMutations.verifyEmailContactMethod({
      userId: user.user_id,
      email: record.email,
    });

    const authResult = await startInteractiveAuth(services, {
      userId: user!.user_id,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "magic-link",
      context: getBootstrapContext(c),
    });

    return jsonWithMutationReceipts(c, authResult, 200, [verifiedEmail]);
  });
}
