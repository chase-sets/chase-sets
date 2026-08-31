import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { authSecurityLifetimesOf, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { mapGuestCheckoutClaimLinkRequestedToNotification } from "../../features/sessions/integrations/notifications/notification-intents";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import { AUTH_GUEST_CHECKOUT_COOKIE_NAME } from "../request-support/cookies";
import {
  bindGuestCheckoutContact,
  consumeChallenge,
  consumeGuestCheckoutClaimContinuationToken,
  consumeGuestCheckoutClaimToken,
  getGuestCheckoutTokenByHash,
  insertGuestCheckoutClaimToken,
  revokeGuestCheckoutTokenByHash,
  revokeGuestCheckoutTokensForAccount,
  upsertGuestCheckoutToken,
  upsertPasskeyCredential,
} from "../auth-support/store";
import { verifyPasskeyRegistration } from "../auth-support/webauthn";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { isGuestCheckoutActor } from "../runtime-support/runtime";
import { createIdentityMutations, createOwnedUserDisplayName, getBootstrapContext, type AuthApiApp } from "./support";

const GUEST_CHECKOUT_CLAIM_LINK_NOTIFICATION_PROJECTION = "auth-guest-checkout-claim-link-notification-intent";
const guestCheckoutClaimIpRateLimiter = createConfiguredInMemoryRateLimiter("auth.guest-checkout.claim.ip", {
  max: 20,
  windowMs: 60 * 60 * 1000,
});
const guestCheckoutClaimAccountRateLimiter = createConfiguredInMemoryRateLimiter("auth.guest-checkout.claim.account", {
  max: 5,
  windowMs: 60 * 60 * 1000,
});

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex < 0) {
          return [part, ""];
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      }),
  );
}

function normalizeDisplayName(value: unknown, email: string) {
  const text = String(value ?? "").trim();
  return text || createOwnedUserDisplayName(email);
}

function guestContactError(code: "guest_contact_required" | "guest_contact_locked") {
  const messageKey =
    code === "guest_contact_required"
      ? "auth.support.apiSupport.guestCheckoutRoutes.guest.contact.is.required"
      : "auth.support.apiSupport.guestCheckoutRoutes.guest.contact.is.locked";
  return {
    error: {
      code,
      message: t(messageKey),
    },
  };
}

function readBoundGuestContact(
  services: AuthServices,
  tokenRecord: Readonly<{ contact_email: string | null; contact_name: string | null }>,
) {
  const contactEmail = services.identity.normalizeEmail(String(tokenRecord.contact_email ?? ""));
  const contactName = String(tokenRecord.contact_name ?? "").trim();
  return contactEmail && contactName ? { contactEmail, contactName } : null;
}

function buildClaimContinuationLink(origin: unknown, paymentId: string, continuation: string) {
  const fallbackOrigin = "https://chasesets.com";
  let baseOrigin = fallbackOrigin;
  if (typeof origin === "string" && origin.trim()) {
    try {
      const parsedOrigin = new URL(origin.trim());
      if (parsedOrigin.protocol === "https:" || parsedOrigin.protocol === "http:") {
        baseOrigin = parsedOrigin.origin;
      }
    } catch {
      baseOrigin = fallbackOrigin;
    }
  }
  const url = new URL(`/checkout/payments/${encodeURIComponent(paymentId)}`, baseOrigin);
  url.searchParams.set("claimContinuation", continuation);
  return url.toString();
}

function requireGuestCheckoutActor(actor: ResolvedActor | null) {
  if (!isGuestCheckoutActor(actor)) {
    return null;
  }

  return actor;
}

function readGuestCheckoutToken(request: Request) {
  return parseCookieHeader(request.headers.get("cookie")).get(AUTH_GUEST_CHECKOUT_COOKIE_NAME) ?? null;
}

function enforceGuestCheckoutClaimIpLimit(request: Request) {
  const decision = guestCheckoutClaimIpRateLimiter.check(publicClientRequestKey(request));
  return decision.limited ? rateLimitExceededJsonResponse("auth.guest-checkout.claim.ip", decision) : null;
}

function enforceGuestCheckoutClaimAccountLimit(accountId: string, qualifier = "account") {
  const decision = guestCheckoutClaimAccountRateLimiter.check(`${qualifier}:${accountId || "unknown"}`);
  return decision.limited ? rateLimitExceededJsonResponse("auth.guest-checkout.claim.account", decision) : null;
}

async function requireGuestCheckoutContext(services: AuthServices, request: Request, actor: ResolvedActor | null) {
  const guestActor = requireGuestCheckoutActor(actor);
  if (!guestActor) {
    return null;
  }

  const guestToken = readGuestCheckoutToken(request);
  if (!guestToken) {
    return null;
  }

  const tokenRecord = await getGuestCheckoutTokenByHash(services.db, services.auth.hashSecret(guestToken));
  if (!tokenRecord || tokenRecord.account_id !== guestActor.accountId) {
    return null;
  }

  return { actor: guestActor, guestToken, tokenRecord };
}

async function resolveClaimUser(
  services: AuthServices,
  identityMutations: ReturnType<typeof createIdentityMutations>,
  params: Readonly<{
    email: string;
    displayName: string;
  }>,
) {
  const existingUser = await services.identity.getUserByEmail(params.email);
  if (existingUser) {
    return existingUser.user_id;
  }

  const created = await identityMutations.createUser({
    email: params.email,
    displayName: params.displayName,
  });
  return created.userId;
}

async function claimGuestAccountAndStartSession(
  services: AuthServices,
  identityMutations: ReturnType<typeof createIdentityMutations>,
  params: Readonly<{
    accountId: string;
    userId: string;
    authenticationMethod: "magic-link" | "passkey";
    context: ReturnType<typeof getBootstrapContext>;
  }>,
) {
  const membership = await identityMutations.claimGuestAccount({
    accountId: params.accountId,
    userId: params.userId,
    roleKey: "owner",
  });

  return startInteractiveAuth(services, {
    userId: params.userId,
    accountId: params.accountId,
    authenticationMethod: params.authenticationMethod,
    context: params.context,
    publishAuthenticationOutcome: true,
    membershipsOverride: [
      {
        membershipId: membership.membershipId,
        accountId: params.accountId,
        roleKey: "owner",
        status: "active",
        rolePermissions: AUTH_ROLE_PERMISSIONS.owner,
      },
    ],
  });
}

export function registerGuestCheckoutRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/guest-checkout/start", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const hasContact = email.length > 0;
    const displayName = hasContact ? normalizeDisplayName(body.displayName, email) : "Guest";
    if (hasContact) {
      const existingUser = await services.identity.getUserByEmail(email);
      if (existingUser) {
        return c.json(
          {
            error: {
              code: "account_sign_in_required",
              message: t("auth.support.apiSupport.guestCheckoutRoutes.sign.in.to.continue.checkout.with.this.email"),
            },
          },
          409,
        );
      }
    }

    const identityMutations = createIdentityMutations(c);
    const account = await identityMutations.createGuestAccount({
      email,
      displayName,
    });
    const tokenId = createId("cmd");
    const guestToken = services.auth.issueOpaqueToken("guest");
    const expiresAt = createExpiryTimestamp(authSecurityLifetimesOf(services).guestCheckoutTtlMs);

    await upsertGuestCheckoutToken(services.db, {
      tokenId,
      accountId: account.accountId,
      contactEmail: hasContact ? email : null,
      contactName: hasContact ? displayName : null,
      tokenHash: services.auth.hashSecret(guestToken),
      expiresAt,
    });

    return c.json(
      {
        accountId: account.accountId,
        guestToken,
        expiresAt,
      },
      201,
    );
  });

  app.post("/guest-checkout/contact", async (c) => {
    const ipLimited = enforceGuestCheckoutClaimIpLimit(c.req.raw);
    if (ipLimited) {
      return ipLimited;
    }
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }
    const accountLimited = enforceGuestCheckoutClaimAccountLimit(context.actor.accountId, "contact");
    if (accountLimited) {
      return accountLimited;
    }

    const body = await c.req.json();
    const contactEmail = services.identity.normalizeEmail(String(body.email ?? ""));
    const contactName = String(body.displayName ?? "").trim();
    if (!contactEmail || !contactName) {
      return c.json(guestContactError("guest_contact_required"), 400);
    }

    const requestedContact = { contactEmail, contactName };
    const currentContact = readBoundGuestContact(services, context.tokenRecord);
    if (currentContact) {
      if (currentContact.contactEmail === contactEmail && currentContact.contactName === contactName) {
        return c.json({ accountId: context.actor.accountId, ...requestedContact });
      }
      return c.json(guestContactError("guest_contact_locked"), 409);
    }

    const existingUser = await services.identity.getUserByEmail(contactEmail);
    if (existingUser) {
      return c.json(
        {
          error: {
            code: "account_sign_in_required",
            message: t("auth.support.apiSupport.guestCheckoutRoutes.sign.in.to.continue.checkout.with.this.email"),
          },
        },
        409,
      );
    }

    const tokenHash = services.auth.hashSecret(context.guestToken);
    const boundRecord = await bindGuestCheckoutContact(services.db, {
      tokenHash,
      accountId: context.actor.accountId,
      contactEmail,
      contactName,
    });
    if (boundRecord) {
      return c.json({ accountId: context.actor.accountId, ...requestedContact });
    }

    const latestRecord = await getGuestCheckoutTokenByHash(services.db, tokenHash);
    if (!latestRecord) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }
    const latestContact = readBoundGuestContact(services, latestRecord);
    if (
      latestContact?.contactEmail === requestedContact.contactEmail &&
      latestContact.contactName === requestedContact.contactName
    ) {
      return c.json({ accountId: context.actor.accountId, ...requestedContact });
    }

    return c.json(guestContactError("guest_contact_locked"), 409);
  });

  app.post("/guest-checkout/exit", async (c) => {
    const guestToken = readGuestCheckoutToken(c.req.raw);
    if (guestToken) {
      await revokeGuestCheckoutTokenByHash(services.db, services.auth.hashSecret(guestToken));
    }

    return c.json({ status: "guest-checkout-ended" });
  });

  app.post("/guest-checkout/claim-context", async (c) => {
    const ipLimited = enforceGuestCheckoutClaimIpLimit(c.req.raw);
    if (ipLimited) {
      return ipLimited;
    }
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }
    const accountLimited = enforceGuestCheckoutClaimAccountLimit(context.actor.accountId, "context");
    if (accountLimited) {
      return accountLimited;
    }

    const body = await c.req.json().catch(() => ({}));
    const contact = readBoundGuestContact(services, context.tokenRecord);
    return c.json({
      accountId: context.actor.accountId,
      paymentId: String(body.paymentId ?? ""),
      contactEmail: contact?.contactEmail ?? null,
      contactName: contact?.contactName ?? null,
    });
  });

  app.post("/guest-checkout/claim-link/request", async (c) => {
    const ipLimited = enforceGuestCheckoutClaimIpLimit(c.req.raw);
    if (ipLimited) {
      return ipLimited;
    }
    const body = await c.req.json();
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }
    const accountLimited = enforceGuestCheckoutClaimAccountLimit(context.actor.accountId, "link");
    if (accountLimited) {
      return accountLimited;
    }

    const contact = readBoundGuestContact(services, context.tokenRecord);
    if (!contact) {
      return c.json(guestContactError("guest_contact_required"), 400);
    }
    const email = contact.contactEmail;
    const displayName = contact.contactName;
    const tokenId = createId("cmd");
    const token = services.auth.issueOpaqueToken("claim");
    const continuation = services.auth.issueOpaqueToken("claim-continuation");
    const expiresAt = createExpiryTimestamp(authSecurityLifetimesOf(services).magicLinkTtlMs);
    const paymentId = String(body.paymentId ?? "").trim();
    const claimLink = buildClaimContinuationLink(body.origin, paymentId, continuation);

    await insertGuestCheckoutClaimToken(services.db, {
      tokenId,
      accountId: context.actor.accountId,
      paymentId,
      email,
      displayName,
      tokenHash: services.auth.hashSecret(token),
      continuationHash: services.auth.hashSecret(continuation),
      expiresAt,
    });

    await services.notificationOutbox.enqueueNotification({
      message: mapGuestCheckoutClaimLinkRequestedToNotification({
        email,
        claimLink,
        correlationId: getBootstrapContext(c).trace?.traceId ?? tokenId,
        idempotencyKey: `auth:guest-checkout-claim-link:${tokenId}`,
      }),
      source: {
        sourceEventId: tokenId,
        sourceGlobalPosition: "0",
        projectionName: GUEST_CHECKOUT_CLAIM_LINK_NOTIFICATION_PROJECTION,
        occurredAt: new Date().toISOString(),
      },
      maxAttempts: 3,
    });

    return c.json({ tokenId, token, expiresAt });
  });

  app.post("/guest-checkout/claim-with-magic-link", async (c) => {
    const ipLimited = enforceGuestCheckoutClaimIpLimit(c.req.raw);
    if (ipLimited) {
      return ipLimited;
    }
    const body = await c.req.json();
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }
    const accountLimited = enforceGuestCheckoutClaimAccountLimit(context.actor.accountId, "magic-link");
    if (accountLimited) {
      return accountLimited;
    }

    const contact = readBoundGuestContact(services, context.tokenRecord);
    if (!contact) {
      return c.json(guestContactError("guest_contact_required"), 400);
    }
    const identityMutations = createIdentityMutations(c);
    const record = await consumeGuestCheckoutClaimToken(services.db, {
      tokenHash: services.auth.hashSecret(String(body.token ?? "")),
      accountId: context.actor.accountId,
      paymentId: String(body.paymentId ?? "").trim(),
      email: contact.contactEmail,
    });
    if (!record) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.claim.link.is.invalid.or.expired") }, 401);
    }

    const displayName = normalizeDisplayName(body.displayName, record.email);
    const userId = await resolveClaimUser(services, identityMutations, {
      email: record.email,
      displayName,
    });

    const authResult = await claimGuestAccountAndStartSession(services, identityMutations, {
      accountId: context.actor.accountId,
      userId,
      authenticationMethod: "magic-link",
      context: getBootstrapContext(c),
    });
    await revokeGuestCheckoutTokenByHash(services.db, services.auth.hashSecret(context.guestToken));

    return c.json(authResult);
  });

  app.post("/guest-checkout/claim-with-continuation", async (c) => {
    const ipLimited = enforceGuestCheckoutClaimIpLimit(c.req.raw);
    if (ipLimited) {
      return ipLimited;
    }
    const body = await c.req.json();
    const paymentId = String(body.paymentId ?? "").trim();
    const continuation = String(body.continuation ?? "").trim();
    const continuationLimited = enforceGuestCheckoutClaimAccountLimit(`${paymentId}:${continuation}`, "continuation");
    if (continuationLimited) {
      return continuationLimited;
    }
    const identityMutations = createIdentityMutations(c);
    const record = await consumeGuestCheckoutClaimContinuationToken(services.db, {
      continuationHash: services.auth.hashSecret(continuation),
      paymentId,
    });
    if (!record) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.claim.link.is.invalid.or.expired") }, 401);
    }

    const userId = await resolveClaimUser(services, identityMutations, {
      email: record.email,
      displayName: normalizeDisplayName(record.display_name, record.email),
    });

    const authResult = await claimGuestAccountAndStartSession(services, identityMutations, {
      accountId: record.account_id,
      userId,
      authenticationMethod: "magic-link",
      context: getBootstrapContext(c),
    });
    await revokeGuestCheckoutTokensForAccount(services.db, record.account_id);

    return c.json(authResult);
  });

  app.post("/guest-checkout/claim-with-passkey", async (c) => {
    const ipLimited = enforceGuestCheckoutClaimIpLimit(c.req.raw);
    if (ipLimited) {
      return ipLimited;
    }
    const body = await c.req.json();
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }
    const accountLimited = enforceGuestCheckoutClaimAccountLimit(context.actor.accountId, "passkey");
    if (accountLimited) {
      return accountLimited;
    }

    const contact = readBoundGuestContact(services, context.tokenRecord);
    if (!contact) {
      return c.json(guestContactError("guest_contact_required"), 400);
    }
    const identityMutations = createIdentityMutations(c);
    const email = contact.contactEmail;
    const displayName = normalizeDisplayName(body.displayName, email);
    const challenge = await consumeChallenge(services.db, {
      challengeId: String(body.challengeId ?? ""),
      purpose: "passkey-register",
      challengeValue: String(body.challenge ?? ""),
    });
    if (!challenge || challenge.email !== email) {
      return c.json(
        { error: t("auth.support.apiSupport.guestCheckoutRoutes.passkey.challenge.is.invalid.or.expired") },
        401,
      );
    }

    const verifiedPasskey = await verifyPasskeyRegistration(c.req.raw, {
      webauthnResponse: body.webauthnResponse,
      expectedChallenge: challenge.challenge_value,
      externalCredentialId: typeof body.externalCredentialId === "string" ? body.externalCredentialId : null,
    });
    if (!verifiedPasskey) {
      return c.json(
        { error: t("auth.support.apiSupport.guestCheckoutRoutes.passkey.challenge.is.invalid.or.expired") },
        401,
      );
    }

    const userId = await resolveClaimUser(services, identityMutations, {
      email,
      displayName,
    });
    if (challenge.user_id && challenge.user_id !== userId) {
      return c.json(
        { error: t("auth.support.apiSupport.guestCheckoutRoutes.passkey.challenge.does.not.match.this.email") },
        401,
      );
    }

    const credentialId = createId("crd");
    await identityMutations.registerPasskeyCredential({
      userId,
      credentialId,
    });
    await upsertPasskeyCredential(services.db, {
      credentialId,
      userId,
      externalCredentialId: verifiedPasskey.externalCredentialId,
      label: String(body.label ?? "Passkey"),
      publicKey: verifiedPasskey.publicKey,
      signCount: verifiedPasskey.signCount,
      credentialDeviceType: verifiedPasskey.credentialDeviceType,
      credentialBackedUp: verifiedPasskey.credentialBackedUp,
    });

    const authResult = await claimGuestAccountAndStartSession(services, identityMutations, {
      accountId: context.actor.accountId,
      userId,
      authenticationMethod: "passkey",
      context: getBootstrapContext(c),
    });
    await revokeGuestCheckoutTokenByHash(services.db, services.auth.hashSecret(context.guestToken));

    return c.json(authResult);
  });
}
