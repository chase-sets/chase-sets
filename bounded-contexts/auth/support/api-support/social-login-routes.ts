import { t } from "@chase-sets/localization";
import {
  AUTH_SOCIAL_LOGIN_STATE_TTL_MS,
  createExpiryTimestamp,
  type AuthMethod,
} from "../../features/sessions/domain/auth-flow";
import {
  appendAccountSelectionCookie,
  appendSessionCookie,
  clearAccountSelectionCookie,
  createRedirectResponse,
} from "../auth-support/http";
import { consumeSocialLoginState, insertSocialLoginState } from "../auth-support/store";
import { startInteractiveAuth, type AuthServices } from "../runtime-support/services";
import type { SocialLoginProviderName } from "../social-login-support/providers";
import { createIdentityMutations, createOwnedUserDisplayName, getBootstrapContext, type AuthApiApp } from "./support";

const SOCIAL_LOGIN_SIGN_IN_FALLBACK_PATH = "/sign-in";
const SOCIAL_LOGIN_REGISTRATION_FALLBACK_PATH = "/register";
const SOCIAL_LOGIN_SUCCESS_PATH = "/account";
const SOCIAL_LOGIN_ACCOUNT_SELECTION_PATH = "/account/select";

type SocialLoginJourney = "sign-in" | "registration";

function isSocialLoginProviderName(value: string): value is SocialLoginProviderName {
  return value === "google" || value === "facebook";
}

function isSocialLoginJourney(value: string): value is SocialLoginJourney {
  return value === "sign-in" || value === "registration";
}

function getSocialLoginProvider(services: AuthServices, providerName: string) {
  return services.socialLoginProviders.find((provider) => provider.providerName === providerName);
}

function getSafeReturnToFromUrl(url: URL) {
  const returnTo = url.searchParams.get("returnTo");
  return returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : SOCIAL_LOGIN_SUCCESS_PATH;
}

function buildSocialRedirectUri(requestUrl: URL, providerName: string) {
  return new URL(`/api/auth/social/${providerName}/callback`, requestUrl.origin).toString();
}

function getFallbackPath(journey: SocialLoginJourney) {
  return journey === "registration" ? SOCIAL_LOGIN_REGISTRATION_FALLBACK_PATH : SOCIAL_LOGIN_SIGN_IN_FALLBACK_PATH;
}

function redirectToFallback(message: string, journey: SocialLoginJourney = "sign-in") {
  const url = new URL(getFallbackPath(journey), "https://chase-sets.local");
  url.searchParams.set("socialLoginError", message);
  return createRedirectResponse(`${url.pathname}${url.search}`);
}

function completeSocialLoginAuthentication(
  request: Request,
  result: Awaited<ReturnType<typeof startInteractiveAuth>>,
  returnTo: string,
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);

  if (result.type === "account-selection-required") {
    appendAccountSelectionCookie(headers, result.selectionToken, request);
    return createRedirectResponse(
      `${SOCIAL_LOGIN_ACCOUNT_SELECTION_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
      headers,
    );
  }

  appendSessionCookie(headers, result.sessionToken, request);
  return createRedirectResponse(returnTo, headers);
}

function getErrorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : null;
}

export function registerSocialLoginRoutes(app: AuthApiApp, services: AuthServices) {
  app.get("/social/providers", (c) =>
    c.json({
      providers: services.socialLoginProviders.map((provider) => ({
        providerName: provider.providerName,
      })),
    }),
  );

  app.get("/social/:provider/start", async (c) => {
    const providerName = c.req.param("provider");
    if (!isSocialLoginProviderName(providerName)) {
      return c.json({ error: t("auth.support.apiSupport.socialLoginRoutes.unsupported.provider") }, 404);
    }

    const provider = getSocialLoginProvider(services, providerName);
    if (!provider) {
      return c.json({ error: t("auth.support.apiSupport.socialLoginRoutes.provider.not.configured") }, 404);
    }

    const requestUrl = new URL(c.req.url);
    const state = services.auth.issueOpaqueToken("social");
    const journey = requestUrl.searchParams.get("journey") === "registration" ? "registration" : "sign-in";
    await insertSocialLoginState(services.db, {
      stateHash: services.auth.hashSecret(state),
      providerName,
      journey,
      returnTo: getSafeReturnToFromUrl(requestUrl),
      expiresAt: createExpiryTimestamp(AUTH_SOCIAL_LOGIN_STATE_TTL_MS),
    });

    return createRedirectResponse(
      provider.createAuthorizationUrl({
        state,
        redirectUri: buildSocialRedirectUri(requestUrl, providerName),
      }),
    );
  });

  app.get("/social/:provider/callback", async (c) => {
    const providerName = c.req.param("provider");
    if (!isSocialLoginProviderName(providerName)) {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.unsupported.provider"));
    }

    const provider = getSocialLoginProvider(services, providerName);
    if (!provider) {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.provider.not.configured"));
    }

    const requestUrl = new URL(c.req.url);
    const state = requestUrl.searchParams.get("state") ?? "";
    const code = requestUrl.searchParams.get("code") ?? "";
    const stateRecord = await consumeSocialLoginState(services.db, {
      stateHash: services.auth.hashSecret(state),
      providerName,
    });
    if (!stateRecord || !code) {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.state.invalid"));
    }

    const journey = isSocialLoginJourney(stateRecord.journey) ? stateRecord.journey : "sign-in";
    let profile: Awaited<ReturnType<typeof provider.exchangeCallback>>;
    try {
      profile = await provider.exchangeCallback({
        code,
        redirectUri: buildSocialRedirectUri(requestUrl, providerName),
      });
    } catch {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.provider.failed"), journey);
    }

    if (!profile.email || !profile.emailVerified) {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.verified.email.required"), journey);
    }

    const identityMutations = createIdentityMutations(c);
    const email = services.identity.normalizeEmail(profile.email);
    let user =
      (await services.identity.getUserBySocialLogin({
        providerName,
        providerSubject: profile.providerSubject,
      })) ?? (await services.identity.getUserByEmail(email));
    let accountId: string | undefined;

    if (!user) {
      const identity = await identityMutations.createPersonalIdentity({
        email,
        displayName: profile.displayName?.trim() || createOwnedUserDisplayName(email),
        givenName: profile.givenName?.trim() || undefined,
        familyName: profile.familyName?.trim() || undefined,
      });
      accountId = identity.accountId;
      user = await services.identity.getUser(identity.userId);
    }

    if (!user || user.status !== "active") {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.user.unavailable"), journey);
    }

    try {
      await identityMutations.linkSocialLogin({
        userId: user.user_id,
        providerName,
        providerSubject: profile.providerSubject,
        email,
      });
    } catch (error) {
      const message =
        getErrorStatus(error) === 409
          ? t("auth.support.apiSupport.socialLoginRoutes.provider.already.linked")
          : t("auth.support.apiSupport.socialLoginRoutes.provider.failed");
      return redirectToFallback(message, journey);
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user.user_id,
      accountId,
      authenticationMethod: providerName as AuthMethod,
      context: getBootstrapContext(c),
    });

    return completeSocialLoginAuthentication(c.req.raw, authResult, stateRecord.return_to);
  });
}
