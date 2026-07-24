import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import { authSecurityLifetimesOf, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import {
  consumeChallenge,
  getPasskeyCredentialByExternalId,
  insertChallenge,
  updatePasskeySignCount,
  upsertPasskeyCredential,
} from "../auth-support/store";
import {
  readWebAuthnCredentialId,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../auth-support/webauthn";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  jsonWithMutationReceipts,
  readIdentityMutationFailure,
  type AuthApiApp,
} from "./support";
import { requireRegistrationAdmission } from "./registration-gates";

export function passkeyMatchesChallengeUser(challengeUserId: string | null, passkeyUserId: string) {
  return challengeUserId !== null && challengeUserId === passkeyUserId;
}

export function resolvePasskeyRegistrationUserId(
  params: Readonly<{
    actorUserId: string | null;
    bodyUserId: string | null;
    challengeUserId: string | null;
  }>,
) {
  if (params.actorUserId && params.bodyUserId && params.bodyUserId !== params.actorUserId) {
    return { status: "forbidden" as const };
  }

  return {
    status: "resolved" as const,
    userId: params.actorUserId ?? params.challengeUserId,
  };
}

export function registerPasskeyRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/passkeys/challenge", async (c) => {
    const body = await c.req.json();
    const challengeId = createId("cmd");
    const challengeValue = services.auth.issueChallenge();
    const email = typeof body.email === "string" ? services.identity.normalizeEmail(body.email) : null;
    const user = email ? await services.identity.getUserByEmail(email) : null;

    await insertChallenge(services.db, {
      challengeId,
      purpose: String(body.purpose ?? ""),
      email,
      userId: user?.user_id ?? null,
      challengeValue,
      expiresAt: createExpiryTimestamp(authSecurityLifetimesOf(services).challengeTtlMs),
    });

    return c.json({ challengeId, challenge: challengeValue });
  });

  app.post("/passkeys/register", async (c) => {
    const body = await c.req.json();
    const identityMutations = createIdentityMutations(c);
    const challenge = await consumeChallenge(services.db, {
      challengeId: String(body.challengeId ?? ""),
      purpose: "passkey-register",
      challengeValue: String(body.challenge ?? ""),
    });
    if (!challenge) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkey.challenge.is.invalid.or.expired") }, 401);
    }

    const verifiedPasskey = await verifyPasskeyRegistration(c.req.raw, {
      webauthnResponse: body.webauthnResponse,
      expectedChallenge: challenge.challenge_value,
      externalCredentialId: typeof body.externalCredentialId === "string" ? body.externalCredentialId : null,
    });
    if (!verifiedPasskey) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkey.challenge.is.invalid.or.expired") }, 401);
    }

    const actor = c.var.actor;
    if (!actor && challenge.user_id) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.sign.in.before.adding.a.passkey") }, 409);
    }

    const resolvedUser = resolvePasskeyRegistrationUserId({
      actorUserId: actor?.userId ?? null,
      bodyUserId: typeof body.userId === "string" ? body.userId : null,
      challengeUserId: challenge.user_id,
    });
    if (resolvedUser.status === "forbidden") {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkeys.can.only.be.linked.to") }, 403);
    }

    let userId = resolvedUser.userId;
    let accountId: string | undefined;
    let membershipId: string | undefined;
    let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>> | null = null;
    if (!userId && challenge.email) {
      const admission = await requireRegistrationAdmission(services, challenge.email);
      if (!admission.ok) {
        return c.json(admission.failure.body, admission.failure.status);
      }

      try {
        identity = await identityMutations.createPersonalIdentity({
          email: challenge.email,
          displayName:
            typeof body.displayName === "string" && body.displayName.trim()
              ? body.displayName
              : createOwnedUserDisplayName(challenge.email),
          consentAffirmed: body.consentAffirmed === true,
          foundersBetaAccessStartedAt: admission.foundersBetaAccessStartedAt,
        });
      } catch (error) {
        const failure = readIdentityMutationFailure(error);
        if (failure) {
          return c.json(failure.body, failure.status);
        }

        throw error;
      }
      userId = identity.userId;
      accountId = identity.accountId;
      membershipId = identity.membershipId;
    }

    if (!userId) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkey.registration.requires.a.user") }, 400);
    }
    if (actor && userId !== actor.userId) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkeys.can.only.be.linked.to") }, 403);
    }

    const credentialId = createId("crd");
    const passkeyCredential = await identityMutations.registerPasskeyCredential({
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

    const authResult =
      !actor && accountId
        ? await startInteractiveAuth(services, {
            userId,
            accountId,
            authenticationMethod: "passkey",
            context: getBootstrapContext(c),
            publishAuthenticationOutcome: true,
            membershipsOverride: membershipId
              ? [
                  {
                    membershipId,
                    accountId,
                    roleKey: "owner",
                    status: "active",
                    rolePermissions: AUTH_ROLE_PERMISSIONS.owner,
                  },
                ]
              : undefined,
          })
        : null;

    return jsonWithMutationReceipts(c, { credentialId, userId, authResult }, 201, [identity, passkeyCredential]);
  });

  app.post("/passkeys/sign-in", async (c) => {
    const body = await c.req.json();
    const challenge = await consumeChallenge(services.db, {
      challengeId: String(body.challengeId ?? ""),
      purpose: "passkey-sign-in",
      challengeValue: String(body.challenge ?? ""),
    });
    if (!challenge) {
      return c.json(
        { error: t("auth.support.apiSupport.passkeyRoutes.passkey.challenge.is.invalid.or.expired.2") },
        401,
      );
    }

    const externalCredentialId =
      typeof body.externalCredentialId === "string" && body.externalCredentialId
        ? body.externalCredentialId
        : readWebAuthnCredentialId(body.webauthnResponse);
    const passkey = externalCredentialId
      ? await getPasskeyCredentialByExternalId(services.db, externalCredentialId)
      : null;
    if (!passkey) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.unknown.passkey.credential") }, 401);
    }
    if (!passkeyMatchesChallengeUser(challenge.user_id, passkey.user_id)) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkey.does.not.match.the.requested") }, 401);
    }

    const verifiedPasskey = await verifyPasskeyAuthentication(c.req.raw, {
      webauthnResponse: body.webauthnResponse,
      expectedChallenge: challenge.challenge_value,
      externalCredentialId: passkey.external_credential_id,
      publicKey: passkey.public_key,
      signCount: Number(passkey.sign_count),
    });
    if (!verifiedPasskey) {
      return c.json({ error: t("auth.support.apiSupport.passkeyRoutes.passkey.does.not.match.the.requested") }, 401);
    }

    await updatePasskeySignCount(services.db, {
      externalCredentialId: verifiedPasskey.externalCredentialId,
      signCount: verifiedPasskey.newSignCount,
      credentialDeviceType: verifiedPasskey.credentialDeviceType,
      credentialBackedUp: verifiedPasskey.credentialBackedUp,
    });

    const authResult = await startInteractiveAuth(services, {
      userId: passkey.user_id,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "passkey",
      context: getBootstrapContext(c),
      publishAuthenticationOutcome: true,
    });

    return c.json(authResult);
  });
}
