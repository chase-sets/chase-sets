import { createId } from "@chase-sets/primitives/typed-ids";
import {
  AUTH_CHALLENGE_TTL_MS,
  createExpiryTimestamp,
} from "../../features/sessions/domain/auth-flow";
import {
  consumeChallenge,
  getPasskeyCredentialByExternalId,
  insertChallenge,
  upsertPasskeyCredential,
} from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  type AuthApiApp,
} from "./support";

export function passkeyMatchesChallengeUser(
  challengeUserId: string | null,
  passkeyUserId: string,
) {
  return challengeUserId === null || challengeUserId === passkeyUserId;
}

export function registerPasskeyRoutes(
  app: AuthApiApp,
  services: AuthServices,
) {
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
      expiresAt: createExpiryTimestamp(AUTH_CHALLENGE_TTL_MS),
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
      return c.json({ error: "Passkey challenge is invalid or expired." }, 401);
    }

    const actor = c.var.actor;
    if (!actor && challenge.user_id) {
      return c.json(
        { error: "Sign in before adding a passkey to an existing account." },
        409,
      );
    }

    let userId =
      (typeof body.userId === "string" ? body.userId : challenge.user_id) ??
      actor?.userId ??
      null;
    let accountId: string | undefined;
    if (!userId && challenge.email) {
      const identity = await identityMutations.createPersonalIdentity({
        email: challenge.email,
        displayName:
          typeof body.displayName === "string" && body.displayName.trim()
            ? body.displayName
            : createOwnedUserDisplayName(challenge.email),
      });
      userId = identity.userId;
      accountId = identity.accountId;
    }

    if (!userId) {
      return c.json({ error: "Passkey registration requires a user." }, 400);
    }
    if (actor && userId !== actor.userId) {
      return c.json({ error: "Passkeys can only be linked to your user." }, 403);
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
      label: String(body.label ?? ""),
      publicKey: String(body.publicKey ?? ""),
    });

    const authResult =
      !actor && accountId
        ? await startInteractiveAuth(services, {
            userId,
            accountId,
            authenticationMethod: "passkey",
            context: getBootstrapContext(c),
          })
        : null;

    return c.json({ credentialId, userId, authResult }, 201);
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
    if (!passkeyMatchesChallengeUser(challenge.user_id, passkey.user_id)) {
      return c.json({ error: "Passkey does not match the requested account." }, 401);
    }

    const authResult = await startInteractiveAuth(services, {
      userId: passkey.user_id,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "passkey",
      context: getBootstrapContext(c),
    });

    return c.json(authResult);
  });
}
