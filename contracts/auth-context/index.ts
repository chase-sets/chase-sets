import type { EventStoreContext } from "@chase-sets/event-core/storage";

export const AUTH_SESSION_COOKIE_NAME = "chase_sets_session";
export const SOCIAL_LOGIN_PROVIDERS = ["google", "facebook"] as const;

export type SocialLoginProviderKey = (typeof SOCIAL_LOGIN_PROVIDERS)[number];

const SOCIAL_LOGIN_PROVIDER_SET = new Set<string>(SOCIAL_LOGIN_PROVIDERS);

export function isSocialLoginProviderKey(value: unknown): value is SocialLoginProviderKey {
  return typeof value === "string" && SOCIAL_LOGIN_PROVIDER_SET.has(value);
}

export type ResolvedActor = Readonly<{
  sessionId: string;
  tenantId: string;
  userId: string;
  accountId: string;
  membershipId: string;
  roleKey: string;
  permissions: readonly string[];
}>;

export type AuthenticatedRequestVariables<TActor extends ResolvedActor = ResolvedActor> = {
  actor: TActor | null;
  context: EventStoreContext | null;
};

export type AuthenticatedApiEnv<TActor extends ResolvedActor = ResolvedActor> = {
  Variables: AuthenticatedRequestVariables<TActor>;
};

export type AuthBootstrapServices = Readonly<{
  identity: Readonly<{
    bootstrapTenantId: string;
  }>;
}>;

export function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex < 0) {
          return [part, ""] as const;
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))] as const;
      }),
  );
}

export function readAuthSessionToken(request: Request): string | null {
  const cookieToken = parseCookieHeader(request.headers.get("cookie")).get(AUTH_SESSION_COOKIE_NAME) ?? null;
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

export function createAuthBootstrapContext(services: AuthBootstrapServices): EventStoreContext {
  return {
    tenantId: services.identity.bootstrapTenantId as EventStoreContext["tenantId"],
    audit: {
      performedByUserId: "usr_identity_system" as EventStoreContext["audit"]["performedByUserId"],
      forAccountId: "acc_identity_system" as EventStoreContext["audit"]["forAccountId"],
    },
    trace: {},
  };
}
