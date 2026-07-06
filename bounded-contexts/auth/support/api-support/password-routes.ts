import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { t } from "@chase-sets/localization";
import { getPasswordCredentialByUserId } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import { getBootstrapContext, type AuthApiApp } from "./support";

const passwordSignInIpFailureRateLimiter = createConfiguredInMemoryRateLimiter("auth.sign-in.ip-failures", {
  max: 5,
  windowMs: 5 * 60 * 1000,
});

const passwordSignInIdentifierFailureRateLimiter = createConfiguredInMemoryRateLimiter(
  "auth.sign-in.identifier-failures",
  {
    max: 5,
    windowMs: 5 * 60 * 1000,
  },
);

function signInIdentifierKey(email: string) {
  return `email:${email || "unknown"}`;
}

function recordFailedPasswordSignIn(ipKey: string, identifierKey: string) {
  passwordSignInIpFailureRateLimiter.check(ipKey);
  passwordSignInIdentifierFailureRateLimiter.check(identifierKey);
}

export function registerPasswordRoutes(app: AuthApiApp, services: AuthServices) {
  app.post("/password-sign-in", async (c) => {
    const body = await c.req.json();
    const email = services.identity.normalizeEmail(String(body.email ?? ""));
    const ipKey = publicClientRequestKey(c.req.raw);
    const identifierKey = signInIdentifierKey(email);
    const ipDecision = passwordSignInIpFailureRateLimiter.peek(ipKey);
    if (ipDecision.limited) {
      return rateLimitExceededJsonResponse("auth.sign-in.ip-failures", ipDecision);
    }
    const identifierDecision = passwordSignInIdentifierFailureRateLimiter.peek(identifierKey);
    if (identifierDecision.limited) {
      return rateLimitExceededJsonResponse("auth.sign-in.identifier-failures", identifierDecision);
    }

    const user = await services.identity.getUserByEmail(email);
    if (!user) {
      recordFailedPasswordSignIn(ipKey, identifierKey);
      return c.json({ error: t("auth.support.apiSupport.passwordRoutes.invalid.email.or.password") }, 401);
    }

    const passwordCredential = await getPasswordCredentialByUserId(services.db, user.user_id);
    if (
      !passwordCredential ||
      !services.auth.verifySecret(String(body.password ?? ""), passwordCredential.secret_hash)
    ) {
      recordFailedPasswordSignIn(ipKey, identifierKey);
      return c.json({ error: t("auth.support.apiSupport.passwordRoutes.invalid.email.or.password.2") }, 401);
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
