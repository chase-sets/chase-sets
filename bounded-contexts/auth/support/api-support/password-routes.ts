import { t } from "@chase-sets/localization";
import { createAuthRateLimitPair } from "../../features/sign-in/api/rate-limits";
import { getPasswordCredentialByUserId, upsertPasswordCredential } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { getBootstrapContext, type AuthApiApp } from "./support";

const passwordSignInFailureRateLimits = createAuthRateLimitPair({
  identifier: {
    surface: "auth.sign-in.identifier-failures",
    rule: { max: 5, windowMs: 5 * 60 * 1000 },
  },
  ip: {
    surface: "auth.sign-in.ip-failures",
    rule: { max: 5, windowMs: 5 * 60 * 1000 },
  },
});

function signInIdentifierKey(email: string) {
  return `email:${email || "unknown"}`;
}

export function registerPasswordRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/password-sign-in", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const identifierKey = signInIdentifierKey(email);
    const rateLimitResponse = passwordSignInFailureRateLimits.peek(c.req.raw, identifierKey);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const user = await services.identity.getUserByEmail(email);
    if (!user) {
      passwordSignInFailureRateLimits.record(c.req.raw, identifierKey);
      return c.json({ error: t("auth.support.apiSupport.passwordRoutes.invalid.email.or.password") }, 401);
    }

    const passwordCredential = await getPasswordCredentialByUserId(services.db, user.user_id);
    const verification = passwordCredential
      ? await services.auth.verifyPassword(String(body.password ?? ""), passwordCredential.secret_hash)
      : { valid: false };
    if (!passwordCredential || !verification.valid) {
      passwordSignInFailureRateLimits.record(c.req.raw, identifierKey);
      return c.json({ error: t("auth.support.apiSupport.passwordRoutes.invalid.email.or.password.2") }, 401);
    }

    // Transparent migration: a successful verify against a legacy SHA-256 (or
    // older scrypt-cost) hash yields an upgraded, salted hash to persist so the
    // credential strengthens on this sign-in with no user-visible reset.
    if (verification.upgradedHash) {
      await upsertPasswordCredential(services.db, {
        credentialId: passwordCredential.credential_id,
        userId: passwordCredential.user_id,
        secretHash: verification.upgradedHash,
      });
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user.user_id,
      accountId: typeof body.accountId === "string" ? body.accountId : undefined,
      authenticationMethod: "password",
      context: getBootstrapContext(c),
    });

    return c.json(authResult);
  });
}
