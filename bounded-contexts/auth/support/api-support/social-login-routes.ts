import { t } from "@chase-sets/localization";
import { isSocialLoginProviderKey } from "@chase-sets/auth-context";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import {
  authSecurityLifetimesOf,
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
  identityMutationFailureMessage,
  readIdentityMutationFailure,
  type AuthApiApp,
} from "./support";
import { requireRegistrationAdmission } from "./registration-gates";
import { registrationConsentSubmission } from "../request-support/registration-consent";

const SOCIAL_LOGIN_SIGN_IN_FALLBACK_PATH = "/sign-in";
const SOCIAL_LOGIN_REGISTRATION_FALLBACK_PATH = "/register";
const SOCIAL_LOGIN_SUCCESS_PATH = "/account";
const SOCIAL_LOGIN_ACCOUNT_SELECTION_PATH = "/account/select";
const ADMIN_SIGN_IN_FALLBACK_PATH = "/access/sign-in";
const ADMIN_SUCCESS_PATH = "/";
const ADMIN_ACCOUNT_SELECTION_PATH = "/access/account-select";
const REGISTRATION_CONSENT_PARAM = "__registrationConsent";

type SocialLoginJourney = "sign-in" | "registration" | "admin" | "link";

type AdminSocialLoginJourney = Extract<SocialLoginJourney, "admin">;

const ACCESS_ADMIN_ROUTE_REQUIRED_PERMISSIONS = [
  { path: "/access/users", permissions: ["security.manage"] },
  { path: "/access/api-keys", permissions: ["security.manage"] },
  { path: "/access/sessions", permissions: ["security.manage"] },
  { path: "/access/memberships", permissions: ["memberships.view"] },
  { path: "/access/invitations", permissions: ["memberships.view"] },
  { path: "/growth/google-shopping", permissions: ["google-shopping.view"] },
  { path: "/growth/waitlist", permissions: ["public-presence.view"] },
  { path: "/growth/promo-bar", permissions: ["public-presence.view"] },
  { path: "/commerce/terms", permissions: ["commercial-terms.view"] },
  { path: "/commerce/postage-policies", permissions: ["postage-policies.view"] },
  { path: "/support/requests", permissions: ["support.manage"] },
  { path: "/support/platform-feedback", permissions: ["platform-feedback.view"] },
  { path: "/platform", permissions: ["projection-operations.view"] },
] as const satisfies readonly { path: string; permissions: readonly string[] }[];

const ACCESS_ADMIN_SECTION_ROOT_REQUIRED_PERMISSIONS = [
  {
    path: "/",
    permissions: [
      "accounts.view",
      "memberships.view",
      "security.manage",
      "catalog.view",
      "commercial-terms.view",
      "postage-policies.view",
      "google-shopping.view",
      "public-presence.view",
      "support.manage",
      "platform-feedback.view",
    ],
  },
  { path: "/access", permissions: ["accounts.view", "memberships.view", "security.manage"] },
  { path: "/growth", permissions: ["google-shopping.view", "public-presence.view"] },
  { path: "/commerce", permissions: ["commercial-terms.view", "postage-policies.view"] },
  { path: "/support", permissions: ["support.manage", "platform-feedback.view"] },
  { path: "/platform", permissions: ["projection-operations.view"] },
] as const satisfies readonly { path: string; permissions: readonly string[] }[];

const isSocialLoginProviderName = isSocialLoginProviderKey satisfies (
  value: string,
) => value is SocialLoginProviderName;

function isSocialLoginJourney(value: string): value is SocialLoginJourney {
  return value === "sign-in" || value === "registration" || value === "admin" || value === "link";
}

function isAdminSocialLoginJourney(value: SocialLoginJourney): value is AdminSocialLoginJourney {
  return value === "admin";
}

function getSocialLoginProvider(services: AuthServices, providerName: string) {
  return services.socialLoginProviders.find((provider) => provider.providerName === providerName);
}

function getDefaultSuccessPath(journey: SocialLoginJourney) {
  if (journey === "admin") {
    return ADMIN_SUCCESS_PATH;
  }
  return SOCIAL_LOGIN_SUCCESS_PATH;
}

function getSafeReturnToFromUrl(url: URL, journey: SocialLoginJourney) {
  const returnTo = url.searchParams.get("returnTo");
  return returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : getDefaultSuccessPath(journey);
}

function encodeRegistrationConsent(
  returnTo: string,
  journey: SocialLoginJourney,
  consent: ReturnType<typeof registrationConsentSubmission>,
) {
  if (journey !== "registration" && journey !== "sign-in") {
    return returnTo;
  }

  const url = new URL(returnTo, "https://chase-sets.local");
  url.searchParams.set(REGISTRATION_CONSENT_PARAM, JSON.stringify(consent));
  return `${url.pathname}${url.search}${url.hash}`;
}

function decodeRegistrationConsent(returnTo: string, journey: SocialLoginJourney) {
  const url = new URL(returnTo, "https://chase-sets.local");
  const carriesRegistrationConsent = journey === "registration" || journey === "sign-in";
  const consent = registrationConsentSubmission(
    carriesRegistrationConsent ? url.searchParams.get(REGISTRATION_CONSENT_PARAM) : null,
    false,
  );
  const affirmed =
    carriesRegistrationConsent &&
    typeof url.searchParams.get(REGISTRATION_CONSENT_PARAM) === "string" &&
    (() => {
      try {
        return JSON.parse(url.searchParams.get(REGISTRATION_CONSENT_PARAM)!)?.affirmed === true;
      } catch {
        return false;
      }
    })();
  url.searchParams.delete(REGISTRATION_CONSENT_PARAM);

  return {
    resolution: consent,
    affirmed,
    returnTo: `${url.pathname}${url.search}${url.hash}`,
  };
}

function buildPublicOrigin(request: Request) {
  return resolvePublicRequestOrigin(request);
}

function buildSocialRedirectUri(request: Request, providerName: string) {
  return new URL(`/api/auth/social/${providerName}/callback`, buildPublicOrigin(request)).toString();
}

function getFallbackPath(journey: SocialLoginJourney) {
  if (journey === "admin") {
    return ADMIN_SIGN_IN_FALLBACK_PATH;
  }
  return journey === "registration" ? SOCIAL_LOGIN_REGISTRATION_FALLBACK_PATH : SOCIAL_LOGIN_SIGN_IN_FALLBACK_PATH;
}

function getAccountSelectionPath(journey: SocialLoginJourney) {
  if (journey === "admin") {
    return ADMIN_ACCOUNT_SELECTION_PATH;
  }

  return SOCIAL_LOGIN_ACCOUNT_SELECTION_PATH;
}

function redirectToFallback(message: string, journey: SocialLoginJourney = "sign-in", returnTo?: string) {
  const url = new URL(getFallbackPath(journey), "https://chase-sets.local");
  url.searchParams.set("socialLoginError", message);
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return createRedirectResponse(`${url.pathname}${url.search}`);
}

function buildSocialLoginLinkStartPath(providerName: SocialLoginProviderName, returnTo: string) {
  const url = new URL(`/api/auth/social/${providerName}/start`, "https://chase-sets.local");
  url.searchParams.set("journey", "link");
  url.searchParams.set("returnTo", returnTo);
  return `${url.pathname}${url.search}`;
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
    appendAccountSelectionCookie(headers, result.selectionToken, result.selectionExpiresAt, request);
    return createRedirectResponse(
      `${getAccountSelectionPath(journey)}?returnTo=${encodeURIComponent(returnTo)}`,
      headers,
    );
  }

  appendSessionCookie(headers, result.sessionToken, result.session.expires_at, request);
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
  returnTo: string,
) {
  const requiredPermissions = getRequiredAdminPermissions(journey, returnTo);
  return requiredPermissions.some((permission) => membership.rolePermissions.includes(permission));
}

function getReturnToPathname(returnTo: string) {
  return new URL(returnTo, "https://chase-sets.local").pathname;
}

function isSameRouteFamily(pathname: string, routePath: string) {
  return pathname === routePath || pathname.startsWith(`${routePath}/`);
}

function getRequiredAdminPermissions(journey: AdminSocialLoginJourney, returnTo: string) {
  const pathname = getReturnToPathname(returnTo);
  const sectionRootPermissions = ACCESS_ADMIN_SECTION_ROOT_REQUIRED_PERMISSIONS.find(
    (entry) => pathname === entry.path,
  )?.permissions;
  if (sectionRootPermissions) {
    return sectionRootPermissions;
  }

  return (
    ACCESS_ADMIN_ROUTE_REQUIRED_PERMISSIONS.find((entry) => isSameRouteFamily(pathname, entry.path))?.permissions ?? [
      "accounts.view",
    ]
  );
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
    if (journey === "link" && !c.var.actor) {
      return redirectToFallback(t("auth.support.apiSupport.support.authentication.required"));
    }
    if (isAdminSocialLoginJourney(journey) && providerName !== "google") {
      return c.json({ error: t("auth.support.apiSupport.socialLoginRoutes.unsupported.admin.provider") }, 404);
    }
    if (isAdminSocialLoginJourney(journey) && getAdminWorkspaceDomains(services).size === 0) {
      return c.json({ error: t("auth.support.apiSupport.socialLoginRoutes.admin.workspace.not.configured") }, 404);
    }
    const returnTo = getSafeReturnToFromUrl(requestUrl, journey);
    await insertSocialLoginState(services.db, {
      stateHash: services.auth.hashSecret(state),
      providerName,
      journey,
      returnTo: encodeRegistrationConsent(
        returnTo,
        journey,
        registrationConsentSubmission(
          requestUrl.searchParams.get("registrationConsent"),
          requestUrl.searchParams.get("consentAffirmed") === "true",
        ),
      ),
      expiresAt: createExpiryTimestamp(authSecurityLifetimesOf(services).socialLoginStateTtlMs),
    });

    return createRedirectResponse(
      provider.createAuthorizationUrl({
        state,
        redirectUri: buildSocialRedirectUri(c.req.raw, providerName),
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
    const registrationConsent = decodeRegistrationConsent(stateRecord.return_to, journey);
    let profile: Awaited<ReturnType<typeof provider.exchangeCallback>>;
    try {
      profile = await provider.exchangeCallback({
        code,
        redirectUri: buildSocialRedirectUri(c.req.raw, providerName),
      });
    } catch {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.provider.failed"), journey);
    }

    if (!requireAllowedAdminWorkspaceDomain(services, journey, profile.hostedDomain)) {
      return redirectToFallback(
        t("auth.support.apiSupport.socialLoginRoutes.admin.workspace.domain.required"),
        journey,
      );
    }

    const linkedUser = await services.identity.getUserBySocialLogin({
      providerName,
      providerSubject: profile.providerSubject,
    });
    const linkActor = journey === "link" ? c.var.actor : null;
    if (journey === "link" && !linkActor) {
      return redirectToFallback(
        t("auth.support.apiSupport.support.authentication.required"),
        "sign-in",
        buildSocialLoginLinkStartPath(providerName, registrationConsent.returnTo),
      );
    }
    if (linkActor && linkedUser && linkedUser.user_id !== linkActor.userId) {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.provider.already.linked"));
    }

    const identityMutations = createIdentityMutations(c);
    let user = linkedUser;
    let accountId: string | undefined;
    let emailForNewLink: string | undefined;

    if (!user) {
      if (linkActor) {
        if (!profile.email) {
          return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.verified.email.required"));
        }
        user = await services.identity.getUser(linkActor.userId);
        emailForNewLink = services.identity.normalizeEmail(profile.email);
      } else {
        if (!profile.email) {
          return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.verified.email.required"), journey);
        }
        if (!profile.emailVerified) {
          return redirectToFallback(
            t("auth.support.apiSupport.socialLoginRoutes.verified.email.required"),
            "sign-in",
            buildSocialLoginLinkStartPath(providerName, registrationConsent.returnTo),
          );
        }

        const email = services.identity.normalizeEmail(profile.email);
        user = await services.identity.getUserByEmail(email);
        emailForNewLink = email;

        if (isAdminSocialLoginJourney(journey)) {
          if (!user) {
            return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.admin.user.required"), journey);
          }
        } else if (!user) {
          const admission = await requireRegistrationAdmission(services, email);
          if (!admission.ok) {
            return redirectToFallback(admission.failure.body.error.message, journey);
          }

          let identity: Awaited<ReturnType<typeof identityMutations.createPersonalIdentity>>;
          try {
            identity = await identityMutations.createPersonalIdentity({
              email,
              displayName: profile.displayName?.trim() || createOwnedUserDisplayName(email),
              givenName: profile.givenName?.trim() || undefined,
              familyName: profile.familyName?.trim() || undefined,
              registrationConsent: registrationConsentSubmission(
                registrationConsent.resolution,
                registrationConsent.affirmed,
              ),
              foundersBetaAccessStartedAt: admission.foundersBetaAccessStartedAt,
            });
          } catch (error) {
            const failure = readIdentityMutationFailure(error);
            if (failure) {
              return redirectToFallback(
                failure.status === 409
                  ? t("identity.api.display.name.already.taken")
                  : identityMutationFailureMessage(failure.body, t("identity.api.display.name.already.taken")),
                journey,
              );
            }

            throw error;
          }
          accountId = identity.accountId;
          user = await services.identity.getUser(identity.userId);
        }
      }
    }

    if (!user || user.status !== "active") {
      return redirectToFallback(t("auth.support.apiSupport.socialLoginRoutes.user.unavailable"), journey);
    }

    if (emailForNewLink) {
      try {
        await identityMutations.linkSocialLogin({
          userId: user.user_id,
          providerName,
          providerSubject: profile.providerSubject,
          email: emailForNewLink,
        });
        if (profile.emailVerified) {
          await identityMutations.verifyEmailContactMethod({
            userId: user.user_id,
            email: emailForNewLink,
          });
        }
      } catch (error) {
        const message =
          getErrorStatus(error) === 409
            ? t("auth.support.apiSupport.socialLoginRoutes.provider.already.linked")
            : t("auth.support.apiSupport.socialLoginRoutes.provider.failed");
        return redirectToFallback(message, journey);
      }
    }

    const membershipsOverride = isAdminSocialLoginJourney(journey)
      ? (await services.identity.listActiveMembershipsForUser(user.user_id)).filter((membership) =>
          hasRequiredAdminPermission(membership, journey, registrationConsent.returnTo),
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
      publishAuthenticationOutcome: true,
    });

    return completeSocialLoginAuthentication(c.req.raw, authResult, registrationConsent.returnTo, journey);
  });
}
