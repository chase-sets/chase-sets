import { t } from "@chase-sets/localization";
import { boundStep, withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import { SessionClosureRequired, type AuthSessionEpochs } from "../../features/sessions/api/owner-epochs";
import { authSecurityLifetimesOf, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { createAuthRateLimitPair } from "../../features/sign-in/api/rate-limits";
import {
  consumeMagicLinkToken,
  finishPendingMagicLinkRegistration,
  hasPendingMagicLinkRegistration,
  insertMagicLinkToken,
  insertPasskeyCredentialIfAbsent,
  insertPasswordCredentialIfAbsent,
  lockPendingMagicLinkRegistration,
  upsertSessionTokenOnClient,
  type PendingMagicLinkRegistration,
} from "../auth-support/store";
import { getSafeSameSitePath } from "../auth-support/same-site-path";
import { ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import {
  insertActiveAuthIdentityMembershipMirror,
  insertCreatedAuthIdentityAccountMirror,
  insertRegisteredAuthIdentityUserMirror,
} from "../auth-support/identity-projection";
import {
  startInteractiveAuth,
  startOrResumeReservedAuth,
  type AuthServices,
  type InteractiveAuthResult,
} from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  jsonWithMutationReceipts,
  readIdentityMutationConflict,
  readRegistrationConsentRejection,
  resolveUnaffirmedRegistrationConsent,
  type AuthApiApp,
  type AuthApiContext,
  type IdentityAuthMutationClient,
} from "./support";
import { requireRegistrationAdmission } from "./registration-gates";

function buildPublicOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
}

function safeLandingPath(value: unknown) {
  return getSafeSameSitePath(value, { trim: true }) ?? "/sign-in/magic";
}

function safeReturnTo(value: unknown) {
  return getSafeSameSitePath(value, { trim: true });
}

const magicLinkRequestRateLimits = createAuthRateLimitPair({
  identifier: {
    surface: "auth.magic-link.request.identifier",
    rule: { max: 3, windowMs: 60 * 60 * 1000 },
  },
  ip: {
    surface: "auth.magic-link.request.ip",
    rule: { max: 10, windowMs: 60 * 60 * 1000 },
  },
});

const magicLinkConsumeRateLimits = createAuthRateLimitPair({
  identifier: {
    surface: "auth.magic-link.consume.token",
    rule: { max: 5, windowMs: 10 * 60 * 1000 },
  },
  ip: {
    surface: "auth.magic-link.consume.ip",
    rule: { max: 10, windowMs: 10 * 60 * 1000 },
  },
});

export function registerMagicLinkRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/magic-link/request", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const rateLimitResponse = magicLinkRequestRateLimits.check(c.req.raw, `email:${email || "unknown"}`);
    if (rateLimitResponse) {
      return rateLimitResponse;
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
    const tokenHash = services.auth.hashSecret(String(body.token ?? ""));
    const rateLimitResponse = magicLinkConsumeRateLimits.check(c.req.raw, tokenHash);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const identityMutations = createIdentityMutations(c);
    const record = await consumeMagicLinkToken(services.db, tokenHash);
    if (!record) {
      if (await hasPendingMagicLinkRegistration(services.db, tokenHash)) {
        return finishPendingRegistration(c, services, identityMutations, {
          tokenHash,
          accountId: typeof body.accountId === "string" ? body.accountId : undefined,
        });
      }
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
          registrationConsent: await resolveUnaffirmedRegistrationConsent(identityMutations),
          foundersBetaAccessStartedAt: admission.foundersBetaAccessStartedAt,
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
      const verifiedEmail = await identityMutations.verifyEmailContactMethod({
        userId: identity.userId,
        email: record.email,
      });
      await insertCreatedAuthIdentityAccountMirror(services.db, {
        accountId: identity.accountId,
        displayName: createOwnedUserDisplayName(record.email),
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
            rolePermissions: ROLE_PERMISSIONS.owner,
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

type PendingRegistrationOutcome =
  | Readonly<{ kind: "signed-in"; result: InteractiveAuthResult; receipts: readonly unknown[] }>
  | Readonly<{ kind: "refused"; status: 400 | 401 | 403 | 409; body: object }>;

const invalidLink = (): PendingRegistrationOutcome => ({
  kind: "refused",
  status: 401,
  body: { error: t("auth.support.apiSupport.magicLinkRoutes.magic.link.is.invalid.or.has") },
});

/**
 * Finishes a Pending Registration link. Its row lock is held on the capped
 * direct lock pool from claim to commit; Identity, Auth reads and the Session
 * start use the ordinary pools. The Session Token write and the link's
 * consumption commit together on the lock client, and the response is sent
 * only after that commit. Every refusal except a terminal consent or admission
 * refusal leaves the link unconsumed and retryable.
 */
async function finishPendingRegistration(
  c: AuthApiContext,
  services: AuthServices,
  identityMutations: IdentityAuthMutationClient,
  request: Readonly<{ tokenHash: string; accountId?: string }>,
) {
  const locks = services.pendingRegistrationLocks;
  const epochs = services.sessionEpochs;
  if (!locks || !epochs) {
    return c.json({ error: t("auth.support.routeSupport.authHost.sign.in.temporarily.unavailable") }, 503);
  }

  const attempt = () =>
    withPgTransaction(
      locks,
      (lockClient) => finalizePendingRegistration({ c, services, identityMutations, epochs, lockClient, ...request }),
      { isolationLevel: "read committed" },
    );
  let outcome: PendingRegistrationOutcome;
  try {
    outcome = await attempt();
  } catch (error) {
    if (!(error instanceof SessionClosureRequired)) throw error;
    // The lock transaction rolled back and released its client; close on the
    // ordinary pool, then retry from the claim.
    await epochs.settleClosure(error.keys);
    outcome = await attempt();
  }

  return outcome.kind === "signed-in"
    ? jsonWithMutationReceipts(c, outcome.result, 200, outcome.receipts)
    : c.json(outcome.body, outcome.status);
}

async function finalizePendingRegistration(
  input: Readonly<{
    c: AuthApiContext;
    services: AuthServices;
    identityMutations: IdentityAuthMutationClient;
    epochs: AuthSessionEpochs;
    lockClient: PgQueryable;
    tokenHash: string;
    accountId?: string;
  }>,
): Promise<PendingRegistrationOutcome> {
  const { c, services, identityMutations, epochs, lockClient } = input;
  await boundStep(lockClient);
  const link = await lockPendingMagicLinkRegistration(lockClient, input.tokenHash);
  if (!link) {
    return invalidLink();
  }
  const pending = link.pendingRegistration;
  const context = getBootstrapContext(c);
  const writeSessionToken = (token: Parameters<typeof upsertSessionTokenOnClient>[1]) =>
    upsertSessionTokenOnClient(lockClient, token, epochs);

  // Ordinary verified-link sign-in: no staged details, credentials or registration mirrors.
  const signInExistingUser = async (userId: string): Promise<PendingRegistrationOutcome> => {
    const verifiedEmail = await identityMutations.verifyEmailContactMethod({ userId, email: link.email });
    const result = await startOrResumeReservedAuth(
      services,
      {
        userId,
        sessionId: pending.reservedSessionId,
        accountId: input.accountId,
        authenticationMethod: "magic-link",
        context,
      },
      writeSessionToken,
    );
    return result ? finish(link, lockClient, result, [verifiedEmail]) : invalidLink();
  };

  const visibleUser = link.userId
    ? await services.identity.getUser(link.userId)
    : await services.identity.getUserByEmail(link.email);
  if (visibleUser && visibleUser.user_id !== pending.reservedUserId) {
    return signInExistingUser(visibleUser.user_id);
  }

  // A reserved User that is already visible was admitted by an earlier attempt.
  let foundersBetaAccessStartedAt: string | undefined;
  if (!visibleUser) {
    const admission = await requireRegistrationAdmission(services, link.email);
    if (!admission.ok) {
      await finishPendingMagicLinkRegistration(lockClient, link.tokenId);
      return { kind: "refused", status: admission.failure.status, body: admission.failure.body };
    }
    foundersBetaAccessStartedAt = admission.foundersBetaAccessStartedAt;
  }

  let identity: Awaited<ReturnType<IdentityAuthMutationClient["createPersonalIdentity"]>>;
  try {
    // Identity's registration claim decides which writes are still missing for the reserved User.
    identity = await identityMutations.createPersonalIdentity({
      email: link.email,
      displayName: pending.displayName,
      givenName: pending.givenName || undefined,
      familyName: pending.familyName || undefined,
      registrationConsent: pending.registrationConsent,
      foundersBetaAccessStartedAt,
      reservedUserId: pending.reservedUserId,
    });
  } catch (error) {
    const consentRejection = readRegistrationConsentRejection(error);
    if (consentRejection) {
      await finishPendingMagicLinkRegistration(lockClient, link.tokenId);
      return { kind: "refused", status: 400, body: consentRejection };
    }
    const conflict = readIdentityMutationConflict(error);
    if (!conflict) {
      throw error;
    }
    // Another User holds the contact claim. Sign that User in once the
    // projection shows it; until then nothing is written and the link stays retryable.
    const winner = await services.identity.getUserByEmail(link.email);
    return winner && winner.user_id !== pending.reservedUserId
      ? signInExistingUser(winner.user_id)
      : { kind: "refused", status: 409, body: conflict };
  }

  const userId = identity.userId;
  const verifiedEmail = await identityMutations.verifyEmailContactMethod({ userId, email: link.email });
  const receipts: unknown[] = [identity, verifiedEmail];
  if (pending.password) {
    receipts.push(
      await identityMutations.enablePasswordCredential({ userId, credentialId: pending.password.credentialId }),
    );
    await insertPasswordCredentialIfAbsent(services.db, { ...pending.password, userId });
  }
  if (pending.passkey) {
    receipts.push(
      await identityMutations.registerPasskeyCredential({ userId, credentialId: pending.passkey.credentialId }),
    );
    await insertPasskeyCredentialIfAbsent(services.db, { ...pending.passkey, userId });
  }

  const registeredAt = new Date().toISOString();
  // A short ordinary-pool transaction: an interrupted attempt leaves no User
  // mirror without its email lookup, and a retry inserts whatever is absent.
  await withPgTransaction(services.pool, async (db) => {
    await insertCreatedAuthIdentityAccountMirror(db, {
      accountId: identity.accountId,
      displayName: pending.displayName,
    });
    await insertRegisteredAuthIdentityUserMirror(db, {
      userId,
      displayName: pending.displayName,
      givenName: pending.givenName,
      familyName: pending.familyName,
      email: link.email,
      emailVerifiedAt: registeredAt,
      authMethods: [...(pending.password ? ["password"] : []), ...(pending.passkey ? ["passkey"] : [])],
      passwordCredentialId: pending.password?.credentialId ?? null,
      passkeyCredentialIds: pending.passkey ? [pending.passkey.credentialId] : [],
      updatedAt: registeredAt,
    });
    await insertActiveAuthIdentityMembershipMirror(db, {
      membershipId: identity.membershipId,
      userId,
      accountId: identity.accountId,
      roleKey: "owner",
      updatedAt: registeredAt,
    });
  });

  const result = await startOrResumeReservedAuth(
    services,
    {
      userId,
      sessionId: pending.reservedSessionId,
      accountId: identity.accountId,
      authenticationMethod: "magic-link",
      context,
      membershipsOverride: [
        {
          membershipId: identity.membershipId,
          accountId: identity.accountId,
          roleKey: "owner",
          status: "active",
          rolePermissions: ROLE_PERMISSIONS.owner,
        },
      ],
    },
    writeSessionToken,
  );
  return result ? finish(link, lockClient, result, receipts) : invalidLink();
}

async function finish(
  link: PendingMagicLinkRegistration,
  lockClient: PgQueryable,
  result: InteractiveAuthResult,
  receipts: readonly unknown[],
): Promise<PendingRegistrationOutcome> {
  await finishPendingMagicLinkRegistration(lockClient, link.tokenId);
  return { kind: "signed-in", result, receipts };
}
