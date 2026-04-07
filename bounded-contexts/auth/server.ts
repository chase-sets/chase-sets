import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  hasPermission as hasActorPermission,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime/http";
import type { InteractiveAuthResult } from "./services";
import { AuthApiError } from "./client";
import {
  appendAccountSelectionCookie,
  appendSessionCookie,
  clearAccountSelectionCookie,
  clearSessionCookie,
  createRedirectResponse,
  getSafeReturnTo,
  readCookie,
} from "./auth-support/http";
import {
  AUTH_ACCOUNT_SELECTION_COOKIE_NAME,
} from "./request-support/cookies";
import { createAuthApiClient } from "./request-support/api-client";
export {
  AUTH_ACCOUNT_SELECTION_COOKIE_NAME,
  AUTH_SESSION_COOKIE_NAME,
} from "./request-support/cookies";

export type { ResolvedActor } from "@chase-sets/auth-runtime";

type AccountSelectionMembership = Readonly<{
  accountId: string;
  roleKey: string;
}>;

export type AccountSelectionLoaderData = Readonly<{
  userId: string;
  memberships: readonly AccountSelectionMembership[];
}>;

type AuthActionError = Readonly<{ error: string }>;

export type AuthHostConfig = Readonly<{
  signInPath: string;
  fallbackPath: string;
  defaultSuccessPath: string;
  accountSelectionPath: string;
  requiredPermission?: string;
  signedOutReturnTo: string;
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
  createSignInAction: () => (
    args: ActionFunctionArgs,
  ) => Promise<Response | AuthActionError>;
  createRegisterAction: () => (
    args: ActionFunctionArgs,
  ) => Promise<Response | AuthActionError>;
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

function completeBrowserAuthentication(
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
          const result = await api.signInWithPassword<InteractiveAuthResult>({
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
          const result = await api.register<InteractiveAuthResult>({
            displayName: formData.get("displayName"),
            email: formData.get("email"),
            password: formData.get("password"),
          });

          return completeAuthentication(request, result);
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
