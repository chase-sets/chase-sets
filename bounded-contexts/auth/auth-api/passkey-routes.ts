import { createId } from "@chase-sets/primitives/typed-ids";
import {
  AUTH_CHALLENGE_TTL_MS,
  createExpiryTimestamp,
} from "../sessions/auth-flow";
import {
  consumeChallenge,
  getPasskeyCredentialByExternalId,
  insertChallenge,
  upsertPasskeyCredential,
} from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../services";
import {
  createIdentityMutations,
  getBootstrapContext,
  getRequiredActor,
  type AuthApiApp,
} from "./support";

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

    const actor = getRequiredActor(c);
    const userId =
      (typeof body.userId === "string" ? body.userId : challenge.user_id) ??
      actor.userId;
    if (!userId) {
      return c.json({ error: "Passkey registration requires a user." }, 400);
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
