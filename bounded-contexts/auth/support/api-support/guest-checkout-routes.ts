import { t } from "@chase-sets/localization";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { AUTH_MAGIC_LINK_TTL_MS, createExpiryTimestamp } from "../../features/sessions/domain/auth-flow";
import { AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import {
  consumeChallenge,
  consumeGuestCheckoutClaimToken,
  getGuestCheckoutTokenByHash,
  insertGuestCheckoutClaimToken,
  revokeGuestCheckoutTokenByHash,
  upsertGuestCheckoutToken,
  upsertPasskeyCredential,
} from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { createIdentityMutations, createOwnedUserDisplayName, getBootstrapContext, type AuthApiApp } from "./support";

const AUTH_GUEST_CHECKOUT_TTL_MS = 1000 * 60 * 60 * 24;
const AUTH_GUEST_CHECKOUT_COOKIE_NAME = "chase_sets_guest_checkout";

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

function requireGuestCheckoutActor(actor: ResolvedActor | null) {
  if (!actor || actor.roleKey !== "guest-buyer") {
    return null;
  }

  return actor;
}

function readGuestCheckoutToken(request: Request) {
  return parseCookieHeader(request.headers.get("cookie")).get(AUTH_GUEST_CHECKOUT_COOKIE_NAME) ?? null;
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
    const displayName = normalizeDisplayName(body.displayName, email);
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

    const identityMutations = createIdentityMutations(c);
    const account = await identityMutations.createGuestAccount({
      email,
      displayName,
    });
    const tokenId = createId("cmd");
    const guestToken = services.auth.issueOpaqueToken("guest");
    const expiresAt = createExpiryTimestamp(AUTH_GUEST_CHECKOUT_TTL_MS);

    await upsertGuestCheckoutToken(services.db, {
      tokenId,
      accountId: account.accountId,
      contactEmail: email,
      contactName: displayName,
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

  app.post("/guest-checkout/exit", async (c) => {
    const guestToken = readGuestCheckoutToken(c.req.raw);
    if (guestToken) {
      await revokeGuestCheckoutTokenByHash(services.db, services.auth.hashSecret(guestToken));
    }

    return c.json({ status: "guest-checkout-ended" });
  });

  app.post("/guest-checkout/claim-context", async (c) => {
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    return c.json({
      accountId: context.actor.accountId,
      paymentId: String(body.paymentId ?? ""),
      contactEmail: context.tokenRecord.contact_email,
      contactName: context.tokenRecord.contact_name,
    });
  });

  app.post("/guest-checkout/claim-link/request", async (c) => {
    const body = await c.req.json();
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }

    const email = context.tokenRecord.contact_email;
    const tokenId = createId("cmd");
    const token = services.auth.issueOpaqueToken("claim");
    const expiresAt = createExpiryTimestamp(AUTH_MAGIC_LINK_TTL_MS);
    const paymentId = String(body.paymentId ?? "").trim();

    await insertGuestCheckoutClaimToken(services.db, {
      tokenId,
      accountId: context.actor.accountId,
      paymentId,
      email,
      tokenHash: services.auth.hashSecret(token),
      expiresAt,
    });

    return c.json({ tokenId, token, expiresAt });
  });

  app.post("/guest-checkout/claim-with-magic-link", async (c) => {
    const body = await c.req.json();
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }

    const identityMutations = createIdentityMutations(c);
    const record = await consumeGuestCheckoutClaimToken(services.db, {
      tokenHash: services.auth.hashSecret(String(body.token ?? "")),
      accountId: context.actor.accountId,
      paymentId: String(body.paymentId ?? "").trim(),
      email: context.tokenRecord.contact_email,
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

  app.post("/guest-checkout/claim-with-passkey", async (c) => {
    const body = await c.req.json();
    const context = await requireGuestCheckoutContext(services, c.req.raw, c.var.actor);
    if (!context) {
      return c.json({ error: t("auth.support.apiSupport.guestCheckoutRoutes.guest.checkout.token.required") }, 401);
    }

    const identityMutations = createIdentityMutations(c);
    const email = context.tokenRecord.contact_email;
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
      externalCredentialId: String(body.externalCredentialId ?? ""),
      label: String(body.label ?? "Passkey"),
      publicKey: String(body.publicKey ?? ""),
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
