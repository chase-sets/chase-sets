import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import { authSecurityLifetimesOf } from "../../features/sessions/domain/auth-flow";
import { mapInvitationAcceptanceLinkRequestedToNotification } from "../../features/sessions/integrations/notifications/notification-intents";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { upsertPasswordCredential } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  readIdentityMutationConflict,
  type AuthApiApp,
} from "./support";
import { screenRegistrationEmailDomain } from "./registration-gates";

const INVITATION_ACCEPTANCE_LINK_NOTIFICATION_PROJECTION = "auth-invitation-acceptance-link-notification-intent";

function invitationUnavailable() {
  return { error: t("auth.support.apiSupport.invitationRoutes.invitation.is.unavailable") };
}

function invalidInvitationToken() {
  return { error: t("auth.support.apiSupport.invitationRoutes.invitation.acceptance.token.invalid.or.expired") };
}

type AuthInvitation = NonNullable<Awaited<ReturnType<AuthServices["identity"]["getInvitation"]>>>;

function isPendingInvitationAvailable(
  invitation: Awaited<ReturnType<AuthServices["identity"]["getInvitation"]>>,
): invitation is AuthInvitation {
  return invitation?.status === "pending" && Date.parse(invitation.expires_at) > Date.now();
}

function identityMutationStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error ? Number(error.status) : null;
}

function safeLandingPath(value: unknown) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/invitations/accept";
}

function invitationTokenExpiresAt(invitationExpiresAt: string, magicLinkTtlMs: number) {
  return new Date(Math.min(Date.now() + magicLinkTtlMs, Date.parse(invitationExpiresAt))).toISOString();
}

function buildInvitationAcceptanceLink(
  request: Request,
  input: Readonly<{
    invitationId: string;
    token: string;
    landingPath: unknown;
  }>,
) {
  const url = new URL(safeLandingPath(input.landingPath), resolvePublicRequestOrigin(request));
  url.searchParams.set("invitationId", input.invitationId);
  url.searchParams.set("token", input.token);
  return url.toString();
}

const invitationAcceptanceLinkIpRateLimiter = createConfiguredInMemoryRateLimiter(
  "auth.invitation.acceptance-link.ip",
  {
    max: 10,
    windowMs: 60 * 60 * 1000,
  },
);

const invitationAcceptanceLinkIdentifierRateLimiter = createConfiguredInMemoryRateLimiter(
  "auth.invitation.acceptance-link.identifier",
  {
    max: 3,
    windowMs: 60 * 60 * 1000,
  },
);

const invitationAcceptIpRateLimiter = createConfiguredInMemoryRateLimiter("auth.invitation.accept.ip", {
  max: 10,
  windowMs: 60 * 60 * 1000,
});

const invitationAcceptIdentifierRateLimiter = createConfiguredInMemoryRateLimiter("auth.invitation.accept.identifier", {
  max: 5,
  windowMs: 60 * 60 * 1000,
});

export function registerInvitationRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/invitations/acceptance-link/request", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const invitationId = String(body.invitationId ?? "");
    const ipDecision = invitationAcceptanceLinkIpRateLimiter.check(publicClientRequestKey(c.req.raw));
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse("auth.invitation.acceptance-link.ip", ipDecision);
    }
    const invitationDecision = invitationAcceptanceLinkIdentifierRateLimiter.check(
      `invitation:${invitationId || "unknown"}`,
    );
    if (invitationDecision.limited) {
      return rateLimitExceededJsonResponse("auth.invitation.acceptance-link.identifier", invitationDecision);
    }

    const invitation = await services.identity.getInvitation(invitationId);
    if (!isPendingInvitationAvailable(invitation)) {
      return c.json(invitationUnavailable(), 404);
    }
    const emailScreen = await screenRegistrationEmailDomain(services, invitation.email);
    if (!emailScreen.ok) {
      return c.json(emailScreen.failure.body, emailScreen.failure.status);
    }

    const token = services.auth.issueOpaqueToken("invite");
    const tokenId = createId("cmd");
    const expiresAt = invitationTokenExpiresAt(invitation.expires_at, authSecurityLifetimesOf(services).magicLinkTtlMs);
    let issued: Awaited<ReturnType<typeof identityMutations.issueInvitationAcceptanceToken>>;
    try {
      issued = await identityMutations.issueInvitationAcceptanceToken({
        invitationId,
        tokenHash: services.auth.hashSecret(token),
        expiresAt,
      });
    } catch (error) {
      const status = identityMutationStatus(error);
      if (status === 404) {
        return c.json(invitationUnavailable(), 404);
      }
      if (status === 403) {
        return c.json(invalidInvitationToken(), 403);
      }
      throw error;
    }

    await services.notificationOutbox.enqueueNotification({
      message: mapInvitationAcceptanceLinkRequestedToNotification({
        email: issued.email,
        invitationLink: buildInvitationAcceptanceLink(c.req.raw, {
          invitationId: issued.invitationId,
          token,
          landingPath: body.landingPath,
        }),
        correlationId: getBootstrapContext(c).trace?.traceId ?? tokenId,
        idempotencyKey: `auth:invitation-acceptance-link:${tokenId}`,
      }),
      source: {
        sourceEventId: tokenId,
        sourceGlobalPosition: "0",
        projectionName: INVITATION_ACCEPTANCE_LINK_NOTIFICATION_PROJECTION,
        occurredAt: new Date().toISOString(),
      },
      maxAttempts: 3,
    });

    return c.json({
      invitationId: issued.invitationId,
      expiresAt: issued.expiresAt,
    });
  });

  app.post("/invitations/accept", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const invitationId = String(body.invitationId ?? "");
    const token = String(body.token ?? "");
    const ipDecision = invitationAcceptIpRateLimiter.check(publicClientRequestKey(c.req.raw));
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse("auth.invitation.accept.ip", ipDecision);
    }
    const invitationDecision = invitationAcceptIdentifierRateLimiter.check(`invitation:${invitationId || "unknown"}`);
    if (invitationDecision.limited) {
      return rateLimitExceededJsonResponse("auth.invitation.accept.identifier", invitationDecision);
    }

    if (!invitationId || !token) {
      return c.json(invalidInvitationToken(), 401);
    }

    const acceptanceTokenHash = services.auth.hashSecret(token);
    let invitation: Awaited<ReturnType<typeof identityMutations.verifyInvitationAcceptanceToken>>;
    try {
      invitation = await identityMutations.verifyInvitationAcceptanceToken({
        invitationId,
        acceptanceTokenHash,
      });
    } catch (error) {
      const status = identityMutationStatus(error);
      if (status === 404) {
        return c.json(invitationUnavailable(), 404);
      }
      if (status === 403) {
        return c.json(invalidInvitationToken(), 401);
      }
      throw error;
    }

    let user = await services.identity.getUserByEmail(invitation.email);
    if (!user) {
      let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
      try {
        identity = await identityMutations.createPersonalIdentity({
          email: invitation.email,
          displayName: createOwnedUserDisplayName(invitation.email),
        });
      } catch (error) {
        const conflict = readIdentityMutationConflict(error);
        if (conflict) {
          return c.json(conflict, 409);
        }

        throw error;
      }
      user = await services.identity.getUser(identity.userId);
    }

    const membership = await identityMutations.acceptInvitationForUser({
      invitationId,
      userId: user!.user_id,
      acceptanceTokenHash,
    });
    await identityMutations.verifyEmailContactMethod({
      userId: user!.user_id,
      email: invitation.email,
    });

    if (body.password) {
      const credentialId = createId("crd");
      await identityMutations.enablePasswordCredential({
        userId: user!.user_id,
        credentialId,
      });
      await upsertPasswordCredential(services.db, {
        credentialId,
        userId: user!.user_id,
        secretHash: services.auth.hashSecret(String(body.password)),
      });
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user!.user_id,
      accountId: invitation.accountId,
      authenticationMethod: body.password ? "password" : "magic-link",
      context: getBootstrapContext(c),
      membershipsOverride: [
        {
          membershipId: membership.membershipId,
          accountId: invitation.accountId,
          roleKey: invitation.roleKey,
          status: "active",
          rolePermissions: AUTH_ROLE_PERMISSIONS[invitation.roleKey as keyof typeof AUTH_ROLE_PERMISSIONS] ?? [],
        },
      ],
    });

    return c.json({
      ...authResult,
      invitationId,
      membershipId: membership.membershipId,
    });
  });
}
