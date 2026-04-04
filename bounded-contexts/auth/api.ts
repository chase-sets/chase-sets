import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  consumeAccountSelectionToken,
  consumeChallenge,
  consumeMagicLinkToken,
  getAccountSelectionTokenByHash,
  getPasswordCredentialByUserId,
  getPasskeyCredentialByExternalId,
  insertAccountSelectionToken,
  insertChallenge,
  insertMagicLinkToken,
  upsertPasskeyCredential,
  upsertPasswordCredential,
  upsertSessionToken,
} from "./auth-support/store";
import {
  revokeSession,
  startSessionForUser,
  type AuthServices,
} from "./services";
import { hasPermission } from "./server";
import { sessionRoutes } from "./sessions/route";

export type AuthApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: import("@chase-sets/auth-context").ResolvedActor | null;
  };
};

function getBootstrapContext(c: { var: AuthApiEnv["Variables"] }) {
  return c.var.context;
}

function getRequiredContext(c: { var: AuthApiEnv["Variables"] }) {
  const context = c.var.context;
  if (!context) {
    throw new Error("Missing auth request context.");
  }

  return context;
}

function getRequiredActor(c: { var: AuthApiEnv["Variables"] }) {
  const actor = c.var.actor;
  if (!actor) {
    throw new Error("Missing auth actor.");
  }

  return actor;
}

async function createPendingAccountSelection(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    authenticationMethod: "password" | "magic-link" | "passkey";
  }>,
) {
  const tokenId = createId("cmd");
  const selectionToken = services.auth.issueOpaqueToken("acct");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 10).toISOString();

  await insertAccountSelectionToken(services.db, {
    tokenId,
    userId: params.userId,
    authenticationMethod: params.authenticationMethod,
    tokenHash: services.auth.hashSecret(selectionToken),
    expiresAt,
  });

  return {
    selectionToken,
    expiresAt,
  };
}

async function toInteractiveAuthResponse(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    authenticationMethod: "password" | "magic-link" | "passkey";
    sessionResult: Awaited<ReturnType<typeof startSessionForUser>>;
  }>,
) {
  if (!params.sessionResult.requiresAccountSelection) {
    const sessionToken = services.auth.issueOpaqueToken("session");
    await upsertSessionToken(services.db, {
      sessionId: params.sessionResult.sessionId,
      tokenHash: services.auth.hashSecret(sessionToken),
      expiresAt: params.sessionResult.session.expires_at,
    });

    return {
      ...params.sessionResult,
      sessionToken,
    };
  }

  const selection = await createPendingAccountSelection(services, {
    userId: params.userId,
    authenticationMethod: params.authenticationMethod,
  });

  return {
    ...params.sessionResult,
    selectionToken: selection.selectionToken,
    selectionExpiresAt: selection.expiresAt,
  };
}

export function buildAuthApi(services: AuthServices) {
  const app = new Hono<AuthApiEnv>();

  app.post("/register", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const existingUser = await services.identity.getUserByEmail(email);
    if (existingUser) {
      return c.json({ error: "A user already exists for that email." }, 409);
    }

    const context = getBootstrapContext(c);
    const identity = await services.identity.createPersonalIdentity({
      email,
      displayName: String(body.displayName ?? ""),
      givenName: body.givenName ? String(body.givenName) : undefined,
      familyName: body.familyName ? String(body.familyName) : undefined,
      consents: Array.isArray(body.consents) ? body.consents : undefined,
      context,
    });

    if (body.password) {
      const credentialId = createId("crd");
      await services.identity.enablePasswordCredential({
        userId: identity.userId,
        credentialId,
        context,
      });
      await upsertPasswordCredential(services.db, {
        credentialId,
        userId: identity.userId,
        secretHash: services.auth.hashSecret(String(body.password)),
      });
    }

    const sessionResult = await startSessionForUser(services, {
      userId: identity.userId,
      accountId: identity.accountId,
      authenticationMethod: body.password ? "password" : "magic-link",
      context,
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: identity.userId,
      authenticationMethod: body.password ? "password" : "magic-link",
      sessionResult,
    });

    return c.json(
      {
        userId: identity.userId,
        accountId: identity.accountId,
        ...authResponse,
      },
      201,
    );
  });

  app.post("/password-sign-in", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const user = await services.identity.getUserByEmail(email);
    if (!user) {
      return c.json({ error: "Invalid email or password." }, 401);
    }

    const passwordCredential = await getPasswordCredentialByUserId(
      services.db,
      user.user_id,
    );
    if (
      !passwordCredential ||
      !services.auth.verifySecret(
        String(body.password ?? ""),
        passwordCredential.secret_hash,
      )
    ) {
      return c.json({ error: "Invalid email or password." }, 401);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: user.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "password",
      context: getBootstrapContext(c),
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: user.user_id,
      authenticationMethod: "password",
      sessionResult,
    });

    return c.json({
      userId: user.user_id,
      ...authResponse,
    });
  });

  app.post("/magic-link/request", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const user = await services.identity.getUserByEmail(email);
    const tokenId = createId("cmd");
    const token = services.auth.issueOpaqueToken("magic");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15).toISOString();

    await insertMagicLinkToken(services.db, {
      tokenId,
      userId: user?.user_id ?? null,
      email,
      tokenHash: services.auth.hashSecret(token),
      expiresAt,
    });

    return c.json({ tokenId, token, expiresAt });
  });

  app.post("/magic-link/consume", async (c) => {
    const body = await c.req.json();
    const record = await consumeMagicLinkToken(
      services.db,
      services.auth.hashSecret(String(body.token ?? "")),
    );
    if (!record) {
      return c.json({ error: "Magic link is invalid or has expired." }, 401);
    }

    let user = record.user_id
      ? await services.identity.getUser(record.user_id)
      : await services.identity.getUserByEmail(record.email);

    const context = getBootstrapContext(c);
    if (!user) {
      const identity = await services.identity.createPersonalIdentity({
        email: record.email,
        displayName: record.email.split("@")[0],
        context,
      });
      user = await services.identity.getUser(identity.userId);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: user!.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "magic-link",
      context,
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: user!.user_id,
      authenticationMethod: "magic-link",
      sessionResult,
    });

    return c.json({
      userId: user!.user_id,
      ...authResponse,
    });
  });

  app.post("/account-selection/resolve", async (c) => {
    const body = await c.req.json();
    const selectionToken = String(body.selectionToken ?? "");
    const selection = await getAccountSelectionTokenByHash(
      services.db,
      services.auth.hashSecret(selectionToken),
    );

    if (!selection) {
      return c.json({ error: "Account selection is invalid or has expired." }, 401);
    }

    const memberships = await services.identity.listActiveMembershipsForUser(
      selection.user_id,
    );
    return c.json({
      userId: selection.user_id,
      memberships,
    });
  });

  app.post("/account-selection/complete", async (c) => {
    const body = await c.req.json();
    const selectionToken = String(body.selectionToken ?? "");
    const selection = await consumeAccountSelectionToken(
      services.db,
      services.auth.hashSecret(selectionToken),
    );

    if (!selection) {
      return c.json({ error: "Account selection is invalid or has expired." }, 401);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: selection.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: selection.authentication_method as
        | "password"
        | "magic-link"
        | "passkey",
      context: getBootstrapContext(c),
    });

    if (sessionResult.requiresAccountSelection) {
      return c.json({ error: "Account selection could not be completed." }, 400);
    }

    const sessionToken = services.auth.issueOpaqueToken("session");
    await upsertSessionToken(services.db, {
      sessionId: sessionResult.sessionId,
      tokenHash: services.auth.hashSecret(sessionToken),
      expiresAt: sessionResult.session.expires_at,
    });

    return c.json({
      userId: selection.user_id,
      ...sessionResult,
      sessionToken,
    });
  });

  app.post("/passkeys/challenge", async (c) => {
    const body = await c.req.json();
    const challengeId = createId("cmd");
    const challengeValue = services.auth.issueChallenge();
    const email =
      typeof body.email === "string"
        ? services.identity.normalizeEmail(body.email)
        : null;
    const user = email ? await services.identity.getUserByEmail(email) : null;

    await insertChallenge(services.db, {
      challengeId,
      purpose: String(body.purpose ?? ""),
      email,
      userId: user?.user_id ?? null,
      challengeValue,
      expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
    });

    return c.json({ challengeId, challenge: challengeValue });
  });

  app.post("/passkeys/register", async (c) => {
    const body = await c.req.json();
    const challenge = await consumeChallenge(services.db, {
      challengeId: String(body.challengeId ?? ""),
      purpose: "passkey-register",
      challengeValue: String(body.challenge ?? ""),
    });
    if (!challenge) {
      return c.json({ error: "Passkey challenge is invalid or expired." }, 401);
    }

    const actor = getRequiredActor(c);
    const context = getRequiredContext(c);
    const userId =
      (typeof body.userId === "string" ? body.userId : challenge.user_id) ??
      actor.userId;
    if (!userId) {
      return c.json({ error: "Passkey registration requires a user." }, 400);
    }

    const credentialId = createId("crd");
    await services.identity.registerPasskeyCredential({
      userId,
      credentialId,
      context,
    });
    await upsertPasskeyCredential(services.db, {
      credentialId,
      userId,
      externalCredentialId: String(body.externalCredentialId ?? ""),
      label: String(body.label ?? ""),
      publicKey: String(body.publicKey ?? ""),
    });
    await services.db.query(
      `INSERT INTO identity_passkey_lookup (
         external_credential_id,
         credential_id,
         user_id,
         label,
         updated_at
       )
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (external_credential_id) DO UPDATE
       SET credential_id = $2,
           user_id = $3,
           label = $4,
           updated_at = now()`,
      [body.externalCredentialId, credentialId, userId, body.label],
    );

    return c.json({ credentialId, userId }, 201);
  });

  app.post("/passkeys/sign-in", async (c) => {
    const body = await c.req.json();
    const challenge = await consumeChallenge(services.db, {
      challengeId: String(body.challengeId ?? ""),
      purpose: "passkey-sign-in",
      challengeValue: String(body.challenge ?? ""),
    });
    if (!challenge) {
      return c.json({ error: "Passkey challenge is invalid or expired." }, 401);
    }

    const passkey = await getPasskeyCredentialByExternalId(
      services.db,
      String(body.externalCredentialId ?? ""),
    );
    if (!passkey) {
      return c.json({ error: "Unknown passkey credential." }, 401);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: passkey.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "passkey",
      context: getBootstrapContext(c),
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: passkey.user_id,
      authenticationMethod: "passkey",
      sessionResult,
    });

    return c.json({
      userId: passkey.user_id,
      ...authResponse,
    });
  });

  app.post("/invitations/accept", async (c) => {
    const body = await c.req.json();
    const invitation = await services.identity.getInvitation(
      String(body.invitationId ?? ""),
    );
    if (!invitation || invitation.status !== "pending") {
      return c.json({ error: "Invitation is unavailable." }, 404);
    }

    const context = getBootstrapContext(c);
    let user = await services.identity.getUserByEmail(invitation.email);
    if (!user) {
      const identity = await services.identity.createPersonalIdentity({
        email: invitation.email,
        displayName: invitation.email.split("@")[0],
        context,
      });
      user = await services.identity.getUser(identity.userId);
    }

    if (body.password) {
      const credentialId = createId("crd");
      await services.identity.enablePasswordCredential({
        userId: user!.user_id,
        credentialId,
        context,
      });
      await upsertPasswordCredential(services.db, {
        credentialId,
        userId: user!.user_id,
        secretHash: services.auth.hashSecret(String(body.password)),
      });
    }

    const membershipId = await services.identity.acceptInvitationForUser({
      invitationId: String(body.invitationId ?? ""),
      userId: user!.user_id,
      accountId: invitation.account_id,
      roleKey: invitation.role_key,
      context,
    });

    const sessionResult = await startSessionForUser(services, {
      userId: user!.user_id,
      accountId: invitation.account_id,
      authenticationMethod: body.password ? "password" : "magic-link",
      context,
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: user!.user_id,
      authenticationMethod: body.password ? "password" : "magic-link",
      sessionResult,
    });

    return c.json({
      invitationId: body.invitationId,
      membershipId,
      userId: user!.user_id,
      ...authResponse,
    });
  });

  app.get("/session", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    return c.json({ actor });
  });

  app.post("/sign-out", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const result = await revokeSession(services, {
      sessionId: actor.sessionId,
      context: getRequiredContext(c),
    });

    return c.json(result);
  });

  app.use("/sessions", async (c, next) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    if (!hasPermission(actor, "security.manage")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    await next();
  });
  app.use("/sessions/*", async (c, next) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    if (!hasPermission(actor, "security.manage")) {
      return c.json({ error: "Forbidden." }, 403);
    }

    await next();
  });
  app.route("/sessions", sessionRoutes(services.sessions));

  return app;
}
