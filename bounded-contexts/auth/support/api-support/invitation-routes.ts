import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, decodeFreshWriteReceipt } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import { authSecurityLifetimesOf } from "../../features/sessions/domain/auth-flow";
import { mapInvitationAcceptanceLinkRequestedToNotification } from "../../features/invitation-acceptance/integrations/notifications/notification-intents";
import {
  hasInvitationAttempt,
  readInvitationAttemptId,
} from "../../features/invitation-acceptance/api/attempt-request";
import {
  acceptInvitationAttempt,
  lookupInvitationAttempt,
  parseJourneyInput,
} from "../../features/invitation-acceptance/api/journey";
import { InvitationAttemptError } from "../../features/invitation-acceptance/domain/attempt";
import { invitationAttemptRollout } from "../../features/invitation-acceptance/api/rollout";
import { ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import {
  consumeChallenge,
  getPasswordCredentialByUserId,
  upsertPasskeyCredential,
  upsertPasswordCredential,
} from "../auth-support/store";
import { verifyPasskeyRegistration } from "../auth-support/webauthn";
import { getSafeSameSitePath } from "../auth-support/same-site-path";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  jsonWithMutationReceipts,
  readIdentityMutationConflict,
  readRegistrationConsentRejection,
  resolveUnaffirmedRegistrationConsent,
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

function safeLandingPath(value: unknown, fallback: string) {
  return getSafeSameSitePath(value, { trim: true }) ?? fallback;
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
  const origin = resolvePublicRequestOrigin(request);
  const fallback = `/invite/${encodeURIComponent(input.invitationId)}`;
  let url = new URL(safeLandingPath(input.landingPath, fallback), origin);
  if (url.origin !== origin) {
    url = new URL(fallback, origin);
  }
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
  app.post("/invitations/inspect", async (c) => {
    const body = await c.req.json();
    const invitationId = String(body.invitationId ?? "");
    const token = String(body.token ?? "");
    const invitation = invitationId ? await services.identity.getInvitation(invitationId) : null;
    if (!invitation) return c.json({ status: "unavailable" as const });
    if (invitation.status === "accepted") return c.json({ status: "accepted" as const });
    if (invitation.status === "cancelled" || invitation.status === "declined") {
      return c.json({ status: "revoked" as const });
    }
    if (invitation.status === "expired" || !(Date.parse(invitation.expires_at) > Date.now())) {
      return c.json({ status: "expired" as const });
    }
    if (!token) return c.json({ status: "unavailable" as const });

    try {
      await createIdentityMutations(c).verifyInvitationAcceptanceToken({
        invitationId,
        acceptanceTokenHash: services.auth.hashSecret(token),
      });
    } catch {
      return c.json({ status: "unavailable" as const });
    }

    return c.json({
      status: "pending" as const,
      invitationId,
      email: invitation.email,
      accountName: invitation.account_display_name || "Chase Sets account",
      invitedByName: invitation.invited_by_display_name || "An account owner",
      roleLabel:
        invitation.role_key === "viewer"
          ? "Viewer"
          : invitation.role_key.replace(/(^|-)([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`),
    });
  });

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

    // The caller (Identity's invitation command) forwards a fresh-write receipt
    // so Auth's invitation projection can catch up before this read. Consume it
    // with a bounded, best-effort wait; on timeout it falls back to reading the
    // projection as-is, so a slow projection never blocks or breaks the email.
    const freshWriteReceipt = decodeFreshWriteReceipt(c.req.header(CHASE_SETS_READ_AFTER_WRITE_HEADER));
    if (freshWriteReceipt && freshWriteReceipt.sources.length > 0) {
      await services.awaitInvitationProjectionFreshness?.(freshWriteReceipt);
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
        accountName: invitation.account_display_name || "a Chase Sets account",
        roleLabel: invitation.role_key === "viewer" ? "Viewer" : invitation.role_key,
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
    const idempotencyKey = c.req.header("Idempotency-Key");
    const hasAttempt = hasInvitationAttempt(body, idempotencyKey);
    if (hasAttempt && !readInvitationAttemptId(body, idempotencyKey)) {
      return c.json(
        { error: { code: "invitation_attempt_invalid", message: t("auth.invitationAttempt.invalid") } },
        400,
      );
    }
    const invitationId = String(body.invitationId ?? "");
    const ipDecision = invitationAcceptIpRateLimiter.check(publicClientRequestKey(c.req.raw));
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse("auth.invitation.accept.ip", ipDecision);
    }
    const invitationDecision = invitationAcceptIdentifierRateLimiter.check(`invitation:${invitationId || "unknown"}`);
    if (invitationDecision.limited) {
      return rateLimitExceededJsonResponse("auth.invitation.accept.identifier", invitationDecision);
    }
    if (hasAttempt) {
      try {
        const result = await acceptInvitationAttempt(
          services,
          createIdentityMutations(c),
          parseJourneyInput(body, idempotencyKey),
          c.req.raw,
          getBootstrapContext(c),
        );
        if (result.type === "attempts-not-active")
          return c.json(
            {
              error: {
                code: "invitation_attempts_not_active",
                message: t("auth.invitationAttempt.notActive"),
              },
            },
            409,
          );
        if ("mutationSources" in result) {
          const { mutationSources, ...body } = result;
          return jsonWithMutationReceipts(c, body, 200, mutationSources);
        }
        return c.json(result);
      } catch (error) {
        if (error instanceof InvitationAttemptError)
          return c.json(
            { error: { code: error.code, message: t("auth.invitationAttempt.safeRecovery") } },
            error.code === "invitation_attempt_invalid"
              ? 400
              : error.code === "invitation_attempt_conflict"
                ? 409
                : 503,
          );
        const consent = readRegistrationConsentRejection(error);
        if (consent) return c.json(consent, 400);
        return c.json(
          {
            error: {
              code: "invitation_attempt_ambiguous",
              message: t("auth.invitationAttempt.safeRecovery"),
            },
          },
          503,
        );
      }
    }
    if (invitationAttemptRollout.requireAttempt)
      return c.json(
        { error: { code: "invitation_attempt_invalid", message: t("auth.invitationAttempt.required") } },
        400,
      );
    const identityMutations = createIdentityMutations(c);
    const token = String(body.token ?? "");

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

    if (!(Date.parse(invitation.expiresAt) > Date.now())) {
      return c.json(invalidInvitationToken(), 401);
    }

    const hasPasskeyRegistration = Boolean(body.challengeId || body.webauthnResponse);
    if (!body.password && !hasPasskeyRegistration) {
      return c.json({ error: t("auth.support.apiSupport.invitationRoutes.choose.a.password.or.passkey") }, 400);
    }

    let verifiedPasskey: Awaited<ReturnType<typeof verifyPasskeyRegistration>> = null;
    if (hasPasskeyRegistration) {
      const challenge = await consumeChallenge(services.db, {
        challengeId: String(body.challengeId ?? ""),
        purpose: "passkey-register",
        challengeValue: String(body.challenge ?? ""),
      });
      if (!challenge || challenge.email !== services.identity.normalizeEmail(invitation.email)) {
        return c.json(invalidInvitationToken(), 401);
      }
      verifiedPasskey = await verifyPasskeyRegistration(c.req.raw, {
        webauthnResponse: body.webauthnResponse,
        expectedChallenge: challenge.challenge_value,
        externalCredentialId: typeof body.externalCredentialId === "string" ? body.externalCredentialId : null,
      });
      if (!verifiedPasskey) return c.json(invalidInvitationToken(), 401);
    }

    const existingUser = await services.identity.getUserByEmail(invitation.email);
    let userId = existingUser?.user_id ?? null;
    let createdIdentity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>> | null = null;
    if (!userId) {
      try {
        createdIdentity = await identityMutations.createPersonalIdentity({
          email: invitation.email,
          displayName: createOwnedUserDisplayName(invitation.email),
          registrationConsent: await resolveUnaffirmedRegistrationConsent(identityMutations),
          foundersBetaAccessStartedAt: new Date().toISOString(),
        });
      } catch (error) {
        const consentRejection = readRegistrationConsentRejection(error);
        if (consentRejection) {
          return c.json(consentRejection, 400);
        }

        const conflict = readIdentityMutationConflict(error);
        if (conflict) {
          return c.json(conflict, 409);
        }

        throw error;
      }
      userId = createdIdentity.userId;
    }

    const existingPasswordCredential = body.password ? await getPasswordCredentialByUserId(services.db, userId) : null;
    const existingPasswordVerification = existingPasswordCredential
      ? await services.auth.verifyPassword(String(body.password), existingPasswordCredential.secret_hash)
      : null;
    if (existingPasswordVerification && !existingPasswordVerification.valid) {
      return c.json({ error: t("auth.support.apiSupport.invitationRoutes.password.is.incorrect") }, 401);
    }

    const membership = await identityMutations.acceptInvitationForUser({
      invitationId,
      userId,
      acceptanceTokenHash,
    });
    const verifiedEmail = await identityMutations.verifyEmailContactMethod({
      userId,
      email: invitation.email,
    });

    let credentialResult: unknown = null;
    if (body.password && !existingPasswordCredential) {
      const credentialId = createId("crd");
      credentialResult = await identityMutations.enablePasswordCredential({
        userId,
        credentialId,
      });
      await upsertPasswordCredential(services.db, {
        credentialId,
        userId,
        secretHash: await services.auth.hashPassword(String(body.password)),
      });
    } else if (existingPasswordCredential && existingPasswordVerification?.upgradedHash) {
      // Transparent migration: strengthen a legacy/weak hash on this successful verify.
      await upsertPasswordCredential(services.db, {
        credentialId: existingPasswordCredential.credential_id,
        userId: existingPasswordCredential.user_id,
        secretHash: existingPasswordVerification.upgradedHash,
      });
    }

    if (verifiedPasskey) {
      const credentialId = createId("crd");
      credentialResult = await identityMutations.registerPasskeyCredential({
        userId,
        credentialId,
      });
      await upsertPasskeyCredential(services.db, {
        credentialId,
        userId,
        externalCredentialId: verifiedPasskey.externalCredentialId,
        label: String(body.label ?? ""),
        publicKey: verifiedPasskey.publicKey,
        signCount: verifiedPasskey.signCount,
        credentialDeviceType: verifiedPasskey.credentialDeviceType,
        credentialBackedUp: verifiedPasskey.credentialBackedUp,
      });
    }

    const authResult = await startInteractiveAuth(services, {
      userId,
      accountId: invitation.accountId,
      authenticationMethod: verifiedPasskey ? "passkey" : "password",
      context: getBootstrapContext(c),
      membershipsOverride: [
        {
          membershipId: membership.membershipId,
          accountId: invitation.accountId,
          roleKey: invitation.roleKey,
          status: "active",
          rolePermissions: ROLE_PERMISSIONS[invitation.roleKey as keyof typeof ROLE_PERMISSIONS] ?? [],
        },
      ],
    });

    return jsonWithMutationReceipts(
      c,
      {
        ...authResult,
        invitationId,
        membershipId: membership.membershipId,
      },
      200,
      [createdIdentity, membership, verifiedEmail, credentialResult],
    );
  });

  app.post("/invitations/acceptance-status", async (c) => {
    try {
      const input = parseJourneyInput(await c.req.json(), c.req.header("Idempotency-Key"));
      const ipDecision = invitationAcceptIpRateLimiter.check(publicClientRequestKey(c.req.raw));
      if (ipDecision.limited) return rateLimitExceededJsonResponse("auth.invitation.accept.ip", ipDecision);
      const invitationDecision = invitationAcceptIdentifierRateLimiter.check(`invitation:${input.invitationId}`);
      if (invitationDecision.limited)
        return rateLimitExceededJsonResponse("auth.invitation.accept.identifier", invitationDecision);
      return c.json(await lookupInvitationAttempt(services, createIdentityMutations(c), input, getBootstrapContext(c)));
    } catch (error) {
      if (error instanceof InvitationAttemptError || [403, 404].includes(identityMutationStatus(error) ?? 0))
        return c.json({ type: "ambiguous" as const });
      return c.json({ type: "ambiguous" as const }, 503);
    }
  });
}
