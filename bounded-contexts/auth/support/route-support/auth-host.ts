import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { t } from "@chase-sets/localization";
import {
  hasPermission as hasActorPermission,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import type { InteractiveAuthResult } from "../runtime-support/services";
export type { InteractiveAuthResult } from "../runtime-support/services";
import { AuthApiError } from "../../client";
import {
  appendAccountSelectionCookie,
  appendSessionCookie,
  clearAccountSelectionCookie,
  clearSessionCookie,
  createRedirectResponse,
  getSafeReturnTo,
  readCookie,
} from "../auth-support/http";
import {
  AUTH_ACCOUNT_SELECTION_COOKIE_NAME,
} from "../request-support/cookies";
import { createAuthApiClient } from "../request-support/api-client";
export {
  AUTH_ACCOUNT_SELECTION_COOKIE_NAME,
  AUTH_SESSION_COOKIE_NAME,
} from "../request-support/cookies";

export type { ResolvedActor } from "@chase-sets/platform-runtime/auth";

type AccountSelectionMembership = Readonly<{
  accountId: string;
  roleKey: string;
}>;

export type AccountSelectionLoaderData = Readonly<{
  userId: string;
  memberships: readonly AccountSelectionMembership[];
}>;

type AuthActionError = Readonly<{ error: string }>;
export type AuthActionNotice =
  | Readonly<{
      status: "magic-link-sent";
      tokenId: string;
      expiresAt: string;
      email?: string;
    }>
  | Readonly<{
      status: "phone-code-sent";
      phone: string;
      expiresAt: string;
      displayName?: string;
    }>
  | Readonly<{
      status: "passkey-recovery";
      message: string;
    }>;
type AuthActionResult = Response | AuthActionError | AuthActionNotice;

type MagicLinkRequestResult = Readonly<{
  tokenId: string;
  expiresAt: string;
}>;

type PhoneCodeRequestResult = Readonly<{
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
  requireActor: (
    request: Request,
    permission?: string,
  ) => Promise<ResolvedActor>;
  requireAccountSelectionToken: (request: Request) => string;
  completeAuthentication: (
    request: Request,
    result: InteractiveAuthResult,
    options?: Readonly<{
      defaultSuccessPath?: string;
      accountSelectionPath?: string;
    }>,
  ) => Response;
  signOutActor: (
    request: Request,
    options?: Readonly<{
      returnTo?: string;
    }>,
  ) => Promise<Response>;
  createSignInAction: () => (args: ActionFunctionArgs) => Promise<AuthActionResult>;
  createRegisterAction: () => (
    args: ActionFunctionArgs,
  ) => Promise<AuthActionResult>;
  createAccountSelectionLoader: () => (
    args: LoaderFunctionArgs,
  ) => Promise<AccountSelectionLoaderData>;
  createAccountSelectionAction: () => (
    args: ActionFunctionArgs,
  ) => Promise<Response | AuthActionError>;
  createSignOutAction: (
    options?: Readonly<{
      returnTo?: string;
    }>,
  ) => (args: ActionFunctionArgs) => Promise<Response>;
}>;

export function hasPermission(
  actor: ResolvedActor | null | undefined,
  permission: string,
) {
  return hasActorPermission(actor, permission);
}

export function createAuthRequestApiClient(request: Request) {
  return createAuthRequestApiClientInternal(request);
}

function createAuthRequestApiClientInternal(request: Request) {
  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth"),
    fetch: createForwardedAuthFetch(request),
  });
}

export async function resolveActorFromAuthContext(options: Readonly<{
  request: Request;
  authApiBasePath?: string;
  fetch?: typeof globalThis.fetch;
}>) {
  return resolveActorFromAuthApi({
    request: options.request,
    authApiBaseUrl: resolveRequestApiBaseUrl(
      options.request,
      options.authApiBasePath ?? "/api/auth",
    ),
    sessionPath: "session",
    fetch: options.fetch,
  });
}

export async function requireActorFromAuthContext(options: Readonly<{
  request: Request;
  permission?: string;
  signInPath?: string;
  authApiBasePath?: string;
  fetch?: typeof globalThis.fetch;
}>) {
  return requireActorFromAuthApi({
    request: options.request,
    permission: options.permission,
    signInPath: options.signInPath,
    authApiBaseUrl: resolveRequestApiBaseUrl(
      options.request,
      options.authApiBasePath ?? "/api/auth",
    ),
    sessionPath: "session",
    fetch: options.fetch,
  });
}

function toActionError(error: unknown): AuthActionError {
  if (error instanceof AuthApiError) {
    return { error: error.message };
  }

  throw error;
}

function addReturnPrompt(path: string, prompt: "add-passkey") {
  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.set("authPrompt", prompt);
  return `${url.pathname}${url.search}${url.hash}`;
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
  }>,
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);

  if (result.type === "account-selection-required") {
    appendAccountSelectionCookie(headers, result.selectionToken, request);
    return createRedirectResponse(
      `${options.accountSelectionPath}?returnTo=${encodeURIComponent(
        getSafeReturnTo(request, options.defaultSuccessPath),
      )}`,
      headers,
    );
  }

  appendSessionCookie(headers, result.sessionToken, request);
  return createRedirectResponse(
    getSafeReturnTo(request, options.defaultSuccessPath),
    headers,
  );
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

  try {
    const api = createAuthRequestApiClientInternal(request);
    await api.signOutCurrentSession();
  } catch {
    // Clearing local cookies is enough to end the browser session.
  }

  return createRedirectResponse(options.returnTo ?? "/", headers);
}

export function defineAuthHost(options: AuthHostConfig): AuthHost {
  const allowManualMagicLinkTokenEntry =
    options.allowManualMagicLinkTokenEntry ?? false;

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
      throw createRedirectResponse(
        `${options.signInPath}?returnTo=${encodeURIComponent(
          buildCurrentPath(request),
        )}`,
      );
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
    }> = {},
  ) {
    return completeBrowserAuthentication(request, result, {
      defaultSuccessPath:
        overrides.defaultSuccessPath ?? options.defaultSuccessPath,
      accountSelectionPath:
        overrides.accountSelectionPath ?? options.accountSelectionPath,
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
        try {
          const formData = await request.formData();
          const api = createAuthRequestApiClientInternal(request);
          const intent = String(formData.get("intent") ?? "password");
          if (intent === "magic-link-request") {
            const result = await api.requestMagicLink<MagicLinkRequestResult>({
              email: formData.get("email"),
            });

            return {
              status: "magic-link-sent",
              tokenId: result.tokenId,
              expiresAt: result.expiresAt,
              email:
                typeof formData.get("email") === "string"
                  ? String(formData.get("email"))
                  : undefined,
            };
          }
          if (intent === "phone-code-request") {
            const result = await api.requestPhoneCode<PhoneCodeRequestResult>({
              phone: formData.get("phone"),
            });

            return {
              status: "phone-code-sent",
              phone: result.phone,
              expiresAt: result.expiresAt,
            };
          }

          if (
            intent === "magic-link-consume" &&
            !allowManualMagicLinkTokenEntry
          ) {
            return {
              error: t("auth.support.routeSupport.authHost.magic.link.token.entry.is.not"),
            };
          }

          const result =
            intent === "magic-link-consume"
              ? await api.consumeMagicLink<InteractiveAuthResult>({
                  token: formData.get("token"),
                  accountId: formData.get("accountId"),
                })
              : intent === "phone-code-consume"
                ? await api.consumePhoneCode<InteractiveAuthResult>({
                    phone: formData.get("phone"),
                    code: formData.get("code"),
                    accountId: formData.get("accountId"),
                  })
              : intent === "passkey-sign-in"
                ? await api.signInWithPasskey<InteractiveAuthResult>({
                    challengeId: formData.get("challengeId"),
                    challenge: formData.get("challenge"),
                    externalCredentialId: formData.get("externalCredentialId"),
                    accountId: formData.get("accountId"),
                  })
                : await api.signInWithPassword<InteractiveAuthResult>({
                    email: formData.get("email"),
                    password: formData.get("password"),
                  });

          return completeAuthentication(request, result);
        } catch (error) {
          return toActionError(error);
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
              phone: result.phone,
              expiresAt: result.expiresAt,
              displayName:
                typeof formData.get("displayName") === "string"
                  ? String(formData.get("displayName"))
                  : undefined,
            };
          }

          const result =
            intent === "passkey-register"
              ? (
                  await api.registerPasskey<PasskeyRegistrationResult>({
                    displayName: formData.get("displayName"),
                    email: formData.get("email"),
                    challengeId: formData.get("challengeId"),
                    challenge: formData.get("challenge"),
                    externalCredentialId: formData.get("externalCredentialId"),
                    label: formData.get("label"),
                    publicKey: formData.get("publicKey"),
                  })
                ).authResult
              : intent === "phone-code-consume"
                ? await api.consumePhoneCode<InteractiveAuthResult>({
                    displayName: formData.get("displayName"),
                    phone: formData.get("phone"),
                    code: formData.get("code"),
                  })
              : await api.register<InteractiveAuthResult>({
                  displayName: formData.get("displayName"),
                  email: formData.get("email"),
                  password: formData.get("password"),
                });

          if (!result) {
            return {
              status: "passkey-recovery",
              message: "The passkey was added. Sign in with it to continue.",
            };
          }

          return completeAuthentication(
            request,
            result,
            intent === "passkey-register"
              ? undefined
              : {
                  defaultSuccessPath: addReturnPrompt(
                    options.defaultSuccessPath,
                    "add-passkey",
                  ),
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
