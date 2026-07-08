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
  agentGrant?: AgentOAuthGrantContext;
}>;

export type AgentOAuthScope =
  | "catalog:read"
  | "checkout:read"
  | "checkout:write"
  | "order:read"
  | "inventory:read"
  | "inventory:write"
  | "listings:read"
  | "listings:write"
  | "offers:read"
  | "offers:write"
  | "fulfillment:read"
  | "fulfillment:write"
  | "payouts:read"
  | "payouts:request"
  | "account:read"
  | "account:manage"
  | "support:read"
  | "support:write";

export type AgentOAuthScopeFamily = Readonly<{
  family: string;
  label: string;
  description: string;
  scopes: readonly AgentOAuthScopeDefinition[];
}>;

export type AgentOAuthScopeDefinition = Readonly<{
  scope: AgentOAuthScope;
  label: string;
  description: string;
  permissions: readonly string[];
}>;

export type AgentOAuthGrantContext = Readonly<{
  grantId: string;
  scopes: readonly AgentOAuthScope[];
  rolePermissions: readonly string[];
}>;

export const AGENT_OAUTH_SCOPE_FAMILIES = [
  {
    family: "catalog",
    label: "Catalog",
    description: "Find catalog records and product details.",
    scopes: [
      {
        scope: "catalog:read",
        label: "Read catalog",
        description: "Find catalog items, blueprints, and public product details.",
        permissions: ["catalog.view"],
      },
    ],
  },
  {
    family: "checkout",
    label: "Checkout",
    description: "Review and update cart and checkout state.",
    scopes: [
      {
        scope: "checkout:read",
        label: "Read checkout",
        description: "Read cart and checkout state for the selected account.",
        permissions: ["orders.view"],
      },
      {
        scope: "checkout:write",
        label: "Manage checkout",
        description: "Update cart and checkout state after confirmation.",
        permissions: ["orders.manage"],
      },
    ],
  },
  {
    family: "orders",
    label: "Orders",
    description: "Read purchase and order history.",
    scopes: [
      {
        scope: "order:read",
        label: "Read orders",
        description: "Read order and purchase history for the selected account.",
        permissions: ["orders.view"],
      },
    ],
  },
  {
    family: "inventory",
    label: "Inventory",
    description: "Read and manage seller inventory.",
    scopes: [
      {
        scope: "inventory:read",
        label: "Read inventory",
        description: "Read inventory items and import batches.",
        permissions: ["inventory.view"],
      },
      {
        scope: "inventory:write",
        label: "Manage inventory",
        description: "Create imports and adjust inventory after confirmation.",
        permissions: ["inventory.manage"],
      },
    ],
  },
  {
    family: "listings",
    label: "Listings",
    description: "Read and manage seller listings.",
    scopes: [
      {
        scope: "listings:read",
        label: "Read listings",
        description: "Read your listings and listing reports.",
        permissions: ["listings.view"],
      },
      {
        scope: "listings:write",
        label: "Manage your listings",
        description: "Create, publish, unpublish, and update your listings after confirmation.",
        permissions: ["listings.manage"],
      },
    ],
  },
  {
    family: "offers",
    label: "Offers",
    description: "Read and manage marketplace offers.",
    scopes: [
      {
        scope: "offers:read",
        label: "Read offers",
        description: "Read buying and selling offers visible to the account.",
        permissions: ["offers.view"],
      },
      {
        scope: "offers:write",
        label: "Manage offers",
        description: "Submit, counter, accept, or decline offers after confirmation.",
        permissions: ["offers.manage"],
      },
    ],
  },
  {
    family: "fulfillment",
    label: "Fulfillment",
    description: "Read and manage seller fulfillment.",
    scopes: [
      {
        scope: "fulfillment:read",
        label: "Read fulfillment",
        description: "Read shipments, labels, and tracking state.",
        permissions: ["fulfillment.view"],
      },
      {
        scope: "fulfillment:write",
        label: "Manage fulfillment",
        description: "Purchase or void labels after confirmation.",
        permissions: ["fulfillment.manage"],
      },
    ],
  },
  {
    family: "payouts",
    label: "Payouts",
    description: "Read payout state and request payouts.",
    scopes: [
      {
        scope: "payouts:read",
        label: "Read payouts",
        description: "Read wallet, ledger, payout, and payout-readiness state.",
        permissions: ["payouts.view"],
      },
      {
        scope: "payouts:request",
        label: "Request payouts",
        description: "Request payouts and create hosted payout setup links after confirmation.",
        permissions: ["payouts.request", "payouts.setup"],
      },
    ],
  },
  {
    family: "account",
    label: "Account",
    description: "Read and manage account details.",
    scopes: [
      {
        scope: "account:read",
        label: "Read account",
        description: "Read account profile, reputation, memberships, and account insights.",
        permissions: ["accounts.view", "memberships.view", "reputation.view"],
      },
      {
        scope: "account:manage",
        label: "Manage account",
        description: "Manage account profile, team access, and account security after confirmation.",
        permissions: ["accounts.manage", "memberships.manage", "security.manage"],
      },
    ],
  },
  {
    family: "support",
    label: "Support",
    description: "Read and manage support requests.",
    scopes: [
      {
        scope: "support:read",
        label: "Read support",
        description: "Read support requests for the selected account.",
        permissions: ["support.view"],
      },
      {
        scope: "support:write",
        label: "Manage support",
        description: "Open and update support requests after confirmation.",
        permissions: ["support.manage"],
      },
    ],
  },
] as const satisfies readonly AgentOAuthScopeFamily[];

export const AGENT_OAUTH_SUPPORTED_SCOPES = AGENT_OAUTH_SCOPE_FAMILIES.flatMap((family) =>
  family.scopes.map((scope) => scope.scope),
) as readonly AgentOAuthScope[];

const AGENT_OAUTH_SCOPE_SET = new Set<string>(AGENT_OAUTH_SUPPORTED_SCOPES);

export function isAgentOAuthScope(value: unknown): value is AgentOAuthScope {
  return typeof value === "string" && AGENT_OAUTH_SCOPE_SET.has(value);
}

export function normalizeAgentOAuthScopes(
  value: unknown,
  fallback: readonly AgentOAuthScope[] = [],
): AgentOAuthScope[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  const scopes = raw
    .filter(isAgentOAuthScope)
    .filter((scope, index, values) => values.indexOf(scope) === index)
    .sort();
  return scopes.length > 0 ? scopes : [...fallback];
}

export function agentOAuthScopesForPermission(permission: string): readonly AgentOAuthScope[] {
  return AGENT_OAUTH_SCOPE_FAMILIES.flatMap((family) =>
    family.scopes
      .filter((scope) => (scope.permissions as readonly string[]).includes(permission))
      .map((scope) => scope.scope),
  );
}

export function agentOAuthScopesForPermissions(permissions: readonly string[]): readonly AgentOAuthScope[] {
  return [
    ...new Set(permissions.flatMap((permission) => [...agentOAuthScopesForPermission(permission)])),
  ].sort() as AgentOAuthScope[];
}

export function resolveAgentOAuthScopedPermissions(
  scopes: readonly string[],
  membershipPermissions: readonly string[],
): readonly string[] {
  const normalizedScopes = normalizeAgentOAuthScopes(scopes);
  const allowedPermissions = new Set<string>(
    AGENT_OAUTH_SCOPE_FAMILIES.flatMap((family) =>
      family.scopes
        .filter((scope) => normalizedScopes.includes(scope.scope))
        .flatMap((scope) => [...scope.permissions]),
    ),
  );

  return membershipPermissions.filter((permission) => allowedPermissions.has(permission));
}

export function missingAgentOAuthScopesForPermissions(
  permissions: readonly string[],
  grantedScopes: readonly string[],
): readonly AgentOAuthScope[] {
  const normalizedGrantedScopes = new Set(normalizeAgentOAuthScopes(grantedScopes));
  return agentOAuthScopesForPermissions(permissions).filter((scope) => !normalizedGrantedScopes.has(scope));
}

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
