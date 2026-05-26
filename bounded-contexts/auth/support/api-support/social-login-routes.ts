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
import {
  createIdentityMutations,
  createOwnedUserDisplayName,
  getBootstrapContext,
  readIdentityMutationConflict,
  type AuthApiApp,
} from "./support";

const SOCIAL_LOGIN_SIGN_IN_FALLBACK_PATH = "/sign-in";
const SOCIAL_LOGIN_REGISTRATION_FALLBACK_PATH = "/register";
const SOCIAL_LOGIN_SUCCESS_PATH = "/account";
const SOCIAL_LOGIN_ACCOUNT_SELECTION_PATH = "/account/select";
const IDENTITY_ADMIN_SIGN_IN_FALLBACK_PATH = "/identity/sign-in";
const IDENTITY_ADMIN_ACCOUNT_SELECTION_PATH = "/identity/account-select";
const CATALOG_ADMIN_SIGN_IN_FALLBACK_PATH = "/catalog/sign-in";
const CATALOG_ADMIN_ACCOUNT_SELECTION_PATH = "/catalog/account-select";

type SocialLoginJourney = "sign-in" | "registration" | "identity-admin" | "catalog-admin";

type AdminSocialLoginJourney = Extract<SocialLoginJourney, "identity-admin" | "catalog-admin">;

const ADMIN_JOURNEY_REQUIRED_PERMISSIONS = {
  "identity-admin": "security.manage",
  "catalog-admin": "catalog.view",
} satisfies Readonly<Record<AdminSocialLoginJourney, string>>;

function isSocialLoginProviderName(value: string): value is SocialLoginProviderName {
  return value === "google" || value === "facebook";
}

function isSocialLoginJourney(value: string): value is SocialLoginJourney {
  return value === "sign-in" || value === "registration" || value === "identity-admin" || value === "catalog-admin";
}

function isAdminSocialLoginJourney(value: SocialLoginJourney): value is AdminSocialLoginJourney {
  return value === "identity-admin" || value === "catalog-admin";
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
  if (journey === "identity-admin") {
    return IDENTITY_ADMIN_SIGN_IN_FALLBACK_PATH;
  }
  if (journey === "catalog-admin") {
    return CATALOG_ADMIN_SIGN_IN_FALLBACK_PATH;
  }
  return journey === "registration" ? SOCIAL_LOGIN_REGISTRATION_FALLBACK_PATH : SOCIAL_LOGIN_SIGN_IN_FALLBACK_PATH;
}

function getAccountSelectionPath(journey: SocialLoginJourney) {
  if (journey === "identity-admin") {
    return IDENTITY_ADMIN_ACCOUNT_SELECTION_PATH;
  }
  if (journey === "catalog-admin") {
    return CATALOG_ADMIN_ACCOUNT_SELECTION_PATH;
  }

  return SOCIAL_LOGIN_ACCOUNT_SELECTION_PATH;
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
  journey: SocialLoginJourney,
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);

  if (result.type === "account-selection-required") {
    appendAccountSelectionCookie(headers, result.selectionToken, request);
    return createRedirectResponse(
      `${getAccountSelectionPath(journey)}?returnTo=${encodeURIComponent(returnTo)}`,
      headers,
    );
  }

  appendSessionCookie(headers, result.sessionToken, request);
  return createRedirectResponse(returnTo, headers);
}

function getErrorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) : null;
}

function normalizeHostedDomain(value: string) {
  return value.trim().toLowerCase();
}

function getAdminWorkspaceDomains(services: AuthServices) {
  return new Set((services.adminGoogleWorkspaceSso?.allowedHostedDomains ?? []).map(normalizeHostedDomain));
}

function getHostedDomainHint(services: AuthServices, journey: SocialLoginJourney) {
  if (!isAdminSocialLoginJourney(journey)) {
    return undefined;
  }

  const domains = [...getAdminWorkspaceDomains(services)];
  if (domains.length === 0) {
    return undefined;
  }

  return domains.length === 1 ? domains[0] : "*";
}

function requireAllowedAdminWorkspaceDomain(
  services: AuthServices,
  journey: SocialLoginJourney,
  hostedDomain: string | null | undefined,
) {
  if (!isAdminSocialLoginJourney(journey)) {
    return true;
  }

  const allowedDomains = getAdminWorkspaceDomains(services);
  if (allowedDomains.size === 0 || !hostedDomain) {
    return false;
  }

  return allowedDomains.has(normalizeHostedDomain(hostedDomain));
}

function hasRequiredAdminPermission(
  membership: Readonly<{
    rolePermissions: readonly string[];
  }>,
  journey: AdminSocialLoginJourney,
) {
  return membership.rolePermissions.includes(ADMIN_JOURNEY_REQUIRED_PERMISSIONS[journey]);
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
    const requestedJourney = requestUrl.searchParams.get("journey") ?? "sign-in";
    const journey = isSocialLoginJourney(requestedJourney) ? requestedJourney : "sign-in";
    if (isAdminSocialLoginJourney(journey) && providerName !== "google") {
      return c.json({ error: t("auth.support.apiSupport.socialLoginRoutes.unsupported.admin.provider") }, 404);
    }
    if (isAdminSocialLoginJourney(journey) && getAdminWorkspaceDomains(services).size === 0) {
      return c.json({ error: t("auth.support.apiSupport.socialLoginRoutes.admin.workspace.not.configured") }, 404);
    }
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
        hostedDomain: getHostedDomainHint(services, journey),
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
    if (!requireAllowedAdminWorkspaceDomain(services, journey, profile.hostedDomain)) {
      return redirectToFallback(
        t("auth.support.apiSupport.socialLoginRoutes.admin.workspace.domain.required"),
        journey,
      );
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
      if (isAdminSocialLoginJourney(journey)) {
        return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.admin.user.required"), journey);
      }

      let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
      try {
        identity = await identityMutations.createPersonalIdentity({
          email,
          displayName: profile.displayName?.trim() || createOwnedUserDisplayName(email),
          givenName: profile.givenName?.trim() || undefined,
          familyName: profile.familyName?.trim() || undefined,
        });
      } catch (error) {
        const conflict = readIdentityMutationConflict(error);
        if (conflict) {
          return redirectToFallback(t("identity.api.display.name.already.taken"), journey);
        }

        throw error;
      }
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

    const membershipsOverride = isAdminSocialLoginJourney(journey)
      ? (await services.identity.listActiveMembershipsForUser(user.user_id)).filter((membership) =>
          hasRequiredAdminPermission(membership, journey),
        )
      : undefined;
    if (isAdminSocialLoginJourney(journey) && membershipsOverride?.length === 0) {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.admin.permission.required"), journey);
    }

    const authResult = await startInteractiveAuth(services, {
      userId: user.user_id,
      accountId,
      authenticationMethod: providerName as AuthMethod,
      context: getBootstrapContext(c),
      membershipsOverride,
    });

    return completeSocialLoginAuthentication(c.req.raw, authResult, stateRecord.return_to, journey);
  });
}
