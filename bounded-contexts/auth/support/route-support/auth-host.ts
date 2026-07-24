import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { t } from "@chase-sets/localization";
import { getMutationResultCommandReceipt, readFreshWriteToken } from "@chase-sets/http/responses";
import {
  hasPermission as hasActorPermission,
  isTransientAuthResolutionError,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import {
  createForwardedAuthFetch,
  navigateAfterWrite,
  redirectAfterWrite,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import type { InteractiveAuthResult } from "../runtime-support/services";
export type { InteractiveAuthResult } from "../runtime-support/services";
import { AuthApiError } from "../../client";
import {
  appendAccountSelectionCookie,
  appendSessionCookie,
  clearAccountSelectionCookie,
  clearGuestCheckoutCookie,
  clearSessionCookie,
  createRedirectResponse,
  getSafeReturnTo,
  readCookie,
} from "../auth-support/http";
import { AUTH_ACCOUNT_SELECTION_COOKIE_NAME, AUTH_GUEST_CHECKOUT_COOKIE_NAME } from "../request-support/cookies";
import { createAuthApiClient } from "../request-support/api-client";
export { AUTH_ACCOUNT_SELECTION_COOKIE_NAME, AUTH_SESSION_COOKIE_NAME } from "../request-support/cookies";

export type { ResolvedActor } from "@chase-sets/platform-runtime/auth";

type AccountSelectionMembership = Readonly<{
  accountId: string;
  accountName: string;
  roleLabel: string;
}>;

export type AccountSelectionLoaderData = Readonly<{
  userId: string;
  memberships: readonly AccountSelectionMembership[];
}>;

type AuthActionError = Readonly<{
  error: string;
  identifier?: string;
  method?: SignInMethod;
}>;
export type AuthActionNotice =
  | Readonly<{
      status: "magic-link-sent";
      tokenId: string;
      expiresAt: string;
      email?: string;
    }>
  | Readonly<{
      status: "phone-code-sent";
      tokenId: string;
      phone: string;
      expiresAt: string;
      displayName?: string;
    }>
  | Readonly<{
      status: "passkey-recovery";
      message: string;
    }>;
type AuthActionResult = Response | AuthActionError | AuthActionNotice;
const TRANSIENT_PASSWORD_SIGN_IN_RETRY_DELAYS_MS = [100, 250] as const;

type MagicLinkRequestResult = Readonly<{
  tokenId: string;
  expiresAt: string;
}>;

type PhoneCodeRequestResult = Readonly<{
  tokenId: string;
  phone: string;
  expiresAt: string;
}>;

export type SignInMethod = "password" | "phone-code" | "magic-link" | "passkey";

export const DEFAULT_SIGN_IN_METHODS = [
  "password",
  "phone-code",
  "magic-link",
  "passkey",
] as const satisfies readonly SignInMethod[];

type PasskeyRegistrationResult = Readonly<{
  credentialId: string;
  userId: string;
  authResult: InteractiveAuthResult | null;
}>;

export type AuthHostConfig = Readonly<{
  signInPath: string;
  fallbackPath: string;
  defaultSuccessPath: string;
  accountSelectionPath: string;
  requiredPermission?: string;
  signedOutReturnTo: string;
  signInMethods?: readonly SignInMethod[];
  allowManualMagicLinkTokenEntry?: boolean;
}>;

export type AuthHost = Readonly<{
  getReturnTo: (request: Request, fallback?: string) => string;
  resolveActor: (request: Request) => Promise<ResolvedActor | null>;
  requireActor: (request: Request, permission?: string) => Promise<ResolvedActor>;
  requireAccountSelectionToken: (request: Request) => string;
  completeAuthentication: (
    request: Request,
    result: InteractiveAuthResult,
    options?: Readonly<{
      defaultSuccessPath?: string;
      accountSelectionPath?: string;
      freshWriteSource?: unknown;
    }>,
  ) => Response;
  signOutActor: (
    request: Request,
    options?: Readonly<{
      returnTo?: string;
    }>,
  ) => Promise<Response>;
  createSignInAction: () => (args: ActionFunctionArgs) => Promise<AuthActionResult>;
  createRegisterAction: () => (args: ActionFunctionArgs) => Promise<AuthActionResult>;
  createAccountSelectionLoader: () => (args: LoaderFunctionArgs) => Promise<AccountSelectionLoaderData>;
  createAccountSelectionAction: () => (args: ActionFunctionArgs) => Promise<Response | AuthActionError>;
  createSignOutAction: (
    options?: Readonly<{
      returnTo?: string;
    }>,
  ) => (args: ActionFunctionArgs) => Promise<Response>;
}>;

export function hasPermission(actor: ResolvedActor | null | undefined, permission: string) {
  return hasActorPermission(actor, permission);
}

export function createAuthRequestApiClient(request: Request) {
  return createAuthRequestApiClientInternal(request);
}

function requestWithoutFreshWrite(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  return new Request(url, {
    headers: request.headers,
    method: request.method,
    signal: request.signal,
  });
}

function shouldRetryWithoutFreshWrite(request: Request, error: unknown) {
  return Boolean(readFreshWriteToken(request)) && isTransientAuthResolutionError(error);
}

function createAuthRequestApiClientInternal(request: Request) {
  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth", { requireInternalApiOrigin: true }),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "auth" }),
  });
}

export async function resolveActorFromAuthContext(
  options: Readonly<{
    request: Request;
    authApiBasePath?: string;
    fetch?: typeof globalThis.fetch;
  }>,
) {
  const authApiBaseUrl = resolveRequestApiBaseUrl(options.request, options.authApiBasePath ?? "/api/auth", {
    requireInternalApiOrigin: true,
  });
  try {
    return await resolveActorFromAuthApi({
      request: options.request,
      authApiBaseUrl,
      sessionPath: "session",
      fetch: options.fetch,
    });
  } catch (error) {
    if (!shouldRetryWithoutFreshWrite(options.request, error)) {
      throw error;
    }

    return resolveActorFromAuthApi({
      request: requestWithoutFreshWrite(options.request),
      authApiBaseUrl,
      sessionPath: "session",
      fetch: options.fetch,
    });
  }
}

export async function requireActorFromAuthContext(
  options: Readonly<{
    request: Request;
    permission?: string;
    signInPath?: string;
    authApiBasePath?: string;
    fetch?: typeof globalThis.fetch;
  }>,
) {
  const authApiBaseUrl = resolveRequestApiBaseUrl(options.request, options.authApiBasePath ?? "/api/auth", {
    requireInternalApiOrigin: true,
  });
  try {
    return await requireActorFromAuthApi({
      request: options.request,
      permission: options.permission,
      signInPath: options.signInPath,
      authApiBaseUrl,
      sessionPath: "session",
      fetch: options.fetch,
    });
  } catch (error) {
    if (!shouldRetryWithoutFreshWrite(options.request, error)) {
      throw error;
    }

    return requireActorFromAuthApi({
      request: requestWithoutFreshWrite(options.request),
      permission: options.permission,
      signInPath: options.signInPath,
      authApiBaseUrl,
      sessionPath: "session",
      fetch: options.fetch,
    });
  }
}

function toActionError(error: unknown): AuthActionError {
  if (error instanceof AuthApiError) {
    return { error: error.message };
  }

  if (isTransientInternalAuthFetchError(error)) {
    return {
      error: t("auth.support.routeSupport.authHost.sign.in.temporarily.unavailable"),
    };
  }

  throw error;
}

function withSignInAttempt(error: AuthActionError, formData: FormData): AuthActionError {
  const intent = String(formData.get("intent") ?? "password");
  const method: SignInMethod =
    intent === "phone-code-request" || intent === "phone-code-consume"
      ? "phone-code"
      : intent === "magic-link-request" || intent === "magic-link-consume"
        ? "magic-link"
        : intent === "passkey-sign-in"
          ? "passkey"
          : "password";
  const submittedIdentifier = formData.get(method === "phone-code" ? "phone" : "email");
  const identifier = typeof submittedIdentifier === "string" ? submittedIdentifier.trim() : "";

  return {
    ...error,
    ...(identifier ? { identifier } : {}),
    method,
  };
}

function isTransientInternalAuthFetchError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = "cause" in error && error.cause && typeof error.cause === "object" ? error.cause : null;
  const code = cause && "code" in cause ? String(cause.code) : "";
  return (
    error instanceof TypeError &&
    /fetch failed|network|terminated/i.test(error.message) &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
  );
}

function waitForRetry(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function magicLinkLandingPath(signInPath: string) {
  return `${signInPath.replace(/\/+$/, "")}/magic`;
}

async function retryTransientPasswordSignIn<T>(operation: () => Promise<T>) {
  for (let attempt = 0; attempt <= TRANSIENT_PASSWORD_SIGN_IN_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryDelayMs = TRANSIENT_PASSWORD_SIGN_IN_RETRY_DELAYS_MS[attempt];
      if (!isTransientInternalAuthFetchError(error) || retryDelayMs === undefined) {
        throw error;
      }

      await waitForRetry(retryDelayMs);
    }
  }

  throw new Error("Password sign-in retry loop exhausted.");
}

function addReturnPrompt(path: string, prompt: "add-passkey") {
  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.set("authPrompt", prompt);
  return `${url.pathname}${url.search}${url.hash}`;
}

function hasReceiptSource(source: unknown, contextName: string) {
  return (
    getMutationResultCommandReceipt(source)?.commitPositions.some(
      (position) => position.sourceContextName === contextName,
    ) ?? false
  );
}

function identityFreshWriteSource(source: unknown) {
  return hasReceiptSource(source, "identity") ? source : undefined;
}

function hasSamePathname(path: string, expectedPath: string) {
  const url = new URL(path, "https://chase-sets.local");
  const expectedUrl = new URL(expectedPath, "https://chase-sets.local");
  return url.pathname === expectedUrl.pathname;
}

function applyScopedContinuationPath(
  path: string,
  source: unknown | undefined,
  options: Readonly<{ scopePath: string }>,
) {
  return source && hasSamePathname(path, options.scopePath)
    ? navigateAfterWrite(source, path, { continuation: "cookie-backed" })
    : path;
}

function createScopedContinuationRedirect(
  path: string,
  headers: Headers,
  source: unknown | undefined,
  options: Readonly<{ scopePath: string }>,
) {
  return source && hasSamePathname(path, options.scopePath)
    ? redirectAfterWrite(source, path, {
        continuation: "cookie-backed",
        headers,
      })
    : createRedirectResponse(path, headers);
}

function requireAccountSelectionTokenOrRedirect(
  request: Request,
  options: Readonly<{
    signInPath?: string;
    fallbackPath?: string;
  }> = {},
) {
  const selectionToken = readCookie(request, AUTH_ACCOUNT_SELECTION_COOKIE_NAME);
  if (!selectionToken) {
    throw createRedirectResponse(
      `${options.signInPath ?? "/sign-in"}?returnTo=${encodeURIComponent(
        getSafeReturnTo(request, options.fallbackPath ?? "/"),
      )}`,
    );
  }

  return selectionToken;
}

export function completeBrowserAuthentication(
  request: Request,
  result: InteractiveAuthResult,
  options: Readonly<{
    defaultSuccessPath: string;
    accountSelectionPath: string;
    freshWriteSource?: unknown;
  }>,
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);
  const successPath = getSafeReturnTo(request, options.defaultSuccessPath);

  if (result.type === "account-selection-required") {
    appendAccountSelectionCookie(headers, result.selectionToken, result.selectionExpiresAt, request);
    const scopedSuccessPath = applyScopedContinuationPath(successPath, options.freshWriteSource, {
      scopePath: options.defaultSuccessPath,
    });
    return createRedirectResponse(
      `${options.accountSelectionPath}?returnTo=${encodeURIComponent(scopedSuccessPath)}`,
      headers,
    );
  }

  appendSessionCookie(headers, result.sessionToken, result.session.expires_at, request);
  return createScopedContinuationRedirect(successPath, headers, options.freshWriteSource, {
    scopePath: options.defaultSuccessPath,
  });
}

async function signOutActorViaAuthApi(
  request: Request,
  options: Readonly<{
    returnTo?: string;
  }> = {},
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);
  clearSessionCookie(headers, request);
  clearGuestCheckoutCookie(headers, request);

  const api = createAuthRequestApiClientInternal(request);
  if (readCookie(request, AUTH_GUEST_CHECKOUT_COOKIE_NAME)) {
    try {
      await api.exitGuestCheckout();
    } catch {
      // Clearing local cookies is enough to end guest checkout in this browser.
    }
  }

  try {
    await api.signOutCurrentSession();
  } catch {
    // Clearing local cookies is enough to end the browser session.
  }

  return createRedirectResponse(options.returnTo ?? "/", headers);
}

export function defineAuthHost(options: AuthHostConfig): AuthHost {
  const allowManualMagicLinkTokenEntry = options.allowManualMagicLinkTokenEntry ?? false;

  function buildCurrentPath(request: Request) {
    const url = new URL(request.url);
    return `${url.pathname}${url.search}`;
  }

  async function resolveActor(request: Request) {
    return resolveActorFromAuthContext({ request });
  }

  async function requireActor(request: Request, permission?: string) {
    const actor = await resolveActor(request);
    if (!actor) {
      throw createRedirectResponse(`${options.signInPath}?returnTo=${encodeURIComponent(buildCurrentPath(request))}`);
    }

    const requiredPermission = permission ?? options.requiredPermission;
    if (requiredPermission && !hasPermission(actor, requiredPermission)) {
      throw new Response("Forbidden.", { status: 403 });
    }

    return actor;
  }

  function completeAuthentication(
    request: Request,
    result: InteractiveAuthResult,
    overrides: Readonly<{
      defaultSuccessPath?: string;
      accountSelectionPath?: string;
      freshWriteSource?: unknown;
    }> = {},
  ) {
    return completeBrowserAuthentication(request, result, {
      defaultSuccessPath: overrides.defaultSuccessPath ?? options.defaultSuccessPath,
      accountSelectionPath: overrides.accountSelectionPath ?? options.accountSelectionPath,
      ...(overrides.freshWriteSource ? { freshWriteSource: overrides.freshWriteSource } : {}),
    });
  }

  return {
    getReturnTo(request, fallback = options.fallbackPath) {
      return getSafeReturnTo(request, fallback);
    },
    resolveActor,
    requireActor,
    requireAccountSelectionToken(request) {
      return requireAccountSelectionTokenOrRedirect(request, {
        signInPath: options.signInPath,
        fallbackPath: options.fallbackPath,
      });
    },
    completeAuthentication,
    async signOutActor(request, overrides = {}) {
      return signOutActorViaAuthApi(request, {
        returnTo: overrides.returnTo ?? options.signedOutReturnTo,
      });
    },
    createSignInAction() {
      return async ({ request }) => {
        let formData: FormData | undefined;
        try {
          const submittedFormData = await request.formData();
          formData = submittedFormData;
          const api = createAuthRequestApiClientInternal(request);
          const intent = String(submittedFormData.get("intent") ?? "password");
          if (intent === "magic-link-request") {
            const result = await api.requestMagicLink<MagicLinkRequestResult>({
              email: submittedFormData.get("email"),
              landingPath: magicLinkLandingPath(options.signInPath),
              returnTo: getSafeReturnTo(request, options.defaultSuccessPath),
            });

            return {
              status: "magic-link-sent",
              tokenId: result.tokenId,
              expiresAt: result.expiresAt,
              email:
                typeof submittedFormData.get("email") === "string" ? String(submittedFormData.get("email")) : undefined,
            };
          }
          if (intent === "phone-code-request") {
            const result = await api.requestPhoneCode<PhoneCodeRequestResult>({
              phone: submittedFormData.get("phone"),
            });

            return {
              status: "phone-code-sent",
              tokenId: result.tokenId,
              phone: result.phone,
              expiresAt: result.expiresAt,
            };
          }

          if (intent === "magic-link-consume" && !allowManualMagicLinkTokenEntry) {
            return withSignInAttempt(
              {
                error: t("auth.support.routeSupport.authHost.magic.link.token.entry.is.not"),
              },
              submittedFormData,
            );
          }

          const result =
            intent === "magic-link-consume"
              ? await api.consumeMagicLink<InteractiveAuthResult>({
                  token: submittedFormData.get("token"),
                  accountId: submittedFormData.get("accountId"),
                })
              : intent === "phone-code-consume"
                ? await api.consumePhoneCode<InteractiveAuthResult>({
                    tokenId: submittedFormData.get("tokenId"),
                    phone: submittedFormData.get("phone"),
                    code: submittedFormData.get("code"),
                    accountId: submittedFormData.get("accountId"),
                  })
                : intent === "passkey-sign-in"
                  ? await api.signInWithPasskey<InteractiveAuthResult>({
                      challengeId: submittedFormData.get("challengeId"),
                      challenge: submittedFormData.get("challenge"),
                      externalCredentialId: submittedFormData.get("externalCredentialId"),
                      webauthnResponse: submittedFormData.get("webauthnResponse"),
                      accountId: submittedFormData.get("accountId"),
                    })
                  : await retryTransientPasswordSignIn(() =>
                      api.signInWithPassword<InteractiveAuthResult>({
                        email: submittedFormData.get("email"),
                        password: submittedFormData.get("password"),
                      }),
                    );

          return completeAuthentication(request, result, {
            freshWriteSource: identityFreshWriteSource(result),
          });
        } catch (error) {
          const actionError = toActionError(error);
          return formData ? withSignInAttempt(actionError, formData) : actionError;
        }
      };
    },
    createRegisterAction() {
      return async ({ request }) => {
        try {
          const formData = await request.formData();
          const api = createAuthRequestApiClientInternal(request);
          const intent = String(formData.get("intent") ?? "password");
          if (intent === "phone-code-request") {
            const result = await api.requestPhoneCode<PhoneCodeRequestResult>({
              phone: formData.get("phone"),
            });

            return {
              status: "phone-code-sent",
              tokenId: result.tokenId,
              phone: result.phone,
              expiresAt: result.expiresAt,
              displayName:
                typeof formData.get("displayName") === "string" ? String(formData.get("displayName")) : undefined,
            };
          }

          let freshWriteSource: unknown;
          let authResult: InteractiveAuthResult | null;
          if (intent === "passkey-register") {
            const passkeyRegistration = await api.registerPasskey<PasskeyRegistrationResult>({
              displayName: formData.get("displayName"),
              email: formData.get("email"),
              challengeId: formData.get("challengeId"),
              challenge: formData.get("challenge"),
              externalCredentialId: formData.get("externalCredentialId"),
              label: formData.get("label"),
              webauthnResponse: formData.get("webauthnResponse"),
              consentAffirmed: formData.get("consentAffirmed") === "true",
            });
            freshWriteSource = identityFreshWriteSource(passkeyRegistration);
            authResult = passkeyRegistration.authResult;
          } else if (intent === "phone-code-consume") {
            authResult = await api.consumePhoneCode<InteractiveAuthResult>({
              tokenId: formData.get("tokenId"),
              displayName: formData.get("displayName"),
              phone: formData.get("phone"),
              code: formData.get("code"),
              consentAffirmed: formData.get("consentAffirmed") === "true",
            });
            freshWriteSource = identityFreshWriteSource(authResult);
          } else {
            authResult = await api.register<InteractiveAuthResult>({
              displayName: formData.get("displayName"),
              email: formData.get("email"),
              password: formData.get("password"),
              consentAffirmed: formData.get("consentAffirmed") === "true",
            });
            freshWriteSource = identityFreshWriteSource(authResult);
          }

          if (!authResult) {
            return {
              status: "passkey-recovery",
              message: "The passkey was added. Sign in with it to continue.",
            };
          }

          return completeAuthentication(
            request,
            authResult,
            intent === "passkey-register"
              ? {
                  ...(freshWriteSource ? { freshWriteSource } : {}),
                }
              : {
                  defaultSuccessPath: addReturnPrompt(options.defaultSuccessPath, "add-passkey"),
                  ...(freshWriteSource ? { freshWriteSource } : {}),
                },
          );
        } catch (error) {
          return toActionError(error);
        }
      };
    },
    createAccountSelectionLoader() {
      return async ({ request }) => {
        const api = createAuthRequestApiClientInternal(request);
        const selectionToken = requireAccountSelectionTokenOrRedirect(request, {
          signInPath: options.signInPath,
          fallbackPath: options.fallbackPath,
        });

        return api.resolveAccountSelection<AccountSelectionLoaderData>({
          selectionToken,
        });
      };
    },
    createAccountSelectionAction() {
      return async ({ request }) => {
        try {
          const formData = await request.formData();
          const api = createAuthRequestApiClientInternal(request);
          const selectionToken = requireAccountSelectionTokenOrRedirect(request, {
            signInPath: options.signInPath,
            fallbackPath: options.fallbackPath,
          });
          const result = await api.completeAccountSelection<InteractiveAuthResult>({
            selectionToken,
            accountId: formData.get("accountId"),
          });

          return completeAuthentication(request, result);
        } catch (error) {
          return toActionError(error);
        }
      };
    },
    createSignOutAction(overrides = {}) {
      return async ({ request }) =>
        signOutActorViaAuthApi(request, {
          returnTo: overrides.returnTo ?? options.signedOutReturnTo,
        });
    },
  };
}
