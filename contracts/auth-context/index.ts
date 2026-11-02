import type { EventStoreContext } from "@chase-sets/event-core/storage";

export const AUTH_SESSION_COOKIE_NAME = "chase_sets_session";
export const AUTH_GUEST_CHECKOUT_COOKIE_NAME = "chase_sets_guest_checkout";
export const STAGING_EBAY_RECEIPT_LOOKUP_SERVICE_ID = "staging-ebay-receipt-lookup";
export const EBAY_RECEIPT_LOOKUP_PERMISSION = "channels.receipt.lookup";
export type ReceiptLookupCredential = Readonly<{ version: 1; token: string; expiresAt: string }>;
export type ReceiptLookupServiceActor = Readonly<{
  kind: "service";
  serviceId: typeof STAGING_EBAY_RECEIPT_LOOKUP_SERVICE_ID;
  permissions: readonly string[];
}>;
export const CHANNEL_CONNECTOR_OPERATIONS = ["claim", "report", "ingest"] as const;
export const CHANNEL_CONNECTOR_SCOPE_FAMILY = {
  key: "channel-connector",
  scopes: Object.freeze(CHANNEL_CONNECTOR_OPERATIONS.map((operation) => `channel-connector:${operation}` as const)),
} as const;
export type ChannelConnectorScope = (typeof CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes)[number];
export function isChannelConnectorScope(value: unknown): value is ChannelConnectorScope {
  return CHANNEL_CONNECTOR_SCOPE_FAMILY.scopes.some((scope) => scope === value);
}
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
  /**
   * When the Auth session this actor was resolved from carries a reliable
   * moment-of-authentication fact (the session's own `started_at`, never
   * overwritten by later account switches or other session mutations), Auth
   * populates this ISO-8601 UTC timestamp. Absent for actor kinds Auth does
   * not track a session-start moment for (guest checkout, UCP/agent bearer
   * tokens). Consumers that require a step-up/"recently authenticated" check
   * -- see `resolveRecentAuthenticationStatus` below -- must fail closed when
   * this is missing rather than treat an unknown moment as recent.
   */
  authenticatedAt?: string | null;
  /**
   * Current Capability Grants Identity holds for this actor's Account, as
   * projected by Auth when it resolved this Session-backed actor. Auth reads
   * them per request, so a grant or revoke applies on the next resolution
   * after projection commit; an already-resolved snapshot keeps its value.
   * Absent when the Account holds no grant and for actor kinds that never
   * carry grants (guest checkout, UCP/agent bearer tokens).
   */
  capabilityAssignments?: readonly ResolvedActorCapabilityAssignment[];
}>;

export type ResolvedActorCapabilityAssignment = Readonly<{
  key: string;
  assignmentId: string;
  version: number;
}>;

/**
 * The recent-authentication ("step-up") outcome for a sensitive action, per
 * ADR 0020's approval matrix: request, approval, and reversal of a Wallet
 * Adjustment each require the acting session to have authenticated within a
 * policy-owned window. This is Auth's existing session-authentication fact
 * (`ResolvedActor.authenticatedAt`), not a new Settlement- or
 * consumer-owned session concept -- callers outside Auth only interpret it.
 *
 * Fails closed: a missing, unparsable, or future `authenticatedAt`, or a
 * non-positive `maxAgeMinutes`, is never treated as recently authenticated.
 */
export type RecentAuthenticationStatus = Readonly<{
  recentlyAuthenticated: boolean;
  authenticatedAt: string | null;
}>;

export function resolveRecentAuthenticationStatus(
  actor: Pick<ResolvedActor, "authenticatedAt">,
  options: Readonly<{ maxAgeMinutes: number; now?: Date }>,
): RecentAuthenticationStatus {
  const authenticatedAt = actor.authenticatedAt ?? null;
  if (authenticatedAt === null || !Number.isFinite(options.maxAgeMinutes) || options.maxAgeMinutes <= 0) {
    return { recentlyAuthenticated: false, authenticatedAt };
  }
  const authenticatedAtMs = Date.parse(authenticatedAt);
  if (Number.isNaN(authenticatedAtMs)) {
    return { recentlyAuthenticated: false, authenticatedAt: null };
  }
  const nowMs = (options.now ?? new Date()).getTime();
  const ageMs = nowMs - authenticatedAtMs;
  const maxAgeMs = options.maxAgeMinutes * 60_000;
  return { recentlyAuthenticated: ageMs >= 0 && ageMs <= maxAgeMs, authenticatedAt };
}

/**
 * Every permission key a role grants or a surface checks. Declaring a key
 * grants it to no one; checks keep taking `string`, and
 * `infrastructure/platform-runtime/permission-keys.test.ts` holds every
 * permission string in the repo to this list.
 */
export const PERMISSION_KEYS = [
  "provider-connections.view",
  "accounts.manage",
  "accounts.view",
  // Authenticity's API checks these; no role grants them.
  "authenticity.manage",
  "authenticity.view",
  "catalog.manage",
  "catalog.view",
  "channels.manage",
  "channels.receipt.lookup",
  "channels.view",
  "commercial-terms.agreements.manage",
  "commercial-terms.manage",
  "commercial-terms.view",
  // Customer Feedback attention checks this; no role grants it.
  "customer-feedback.privacy.export-sensitive-feedback",
  "fulfillment.manage",
  "fulfillment.view",
  "return-intake.manage",
  "return-intake.view",
  "google-shopping.manage",
  "google-shopping.view",
  // Auth grants this to guest checkout actors, never through a role.
  "guest-checkout.manage",
  "insights-dashboards.view",
  "memberships.manage",
  "memberships.view",
  "inventory.manage",
  "inventory.view",
  "listings.manage",
  // The Seller Desk price action requires this; no role grants it.
  "listings.price",
  "listings.view",
  "listing-evidence-policy.activate",
  "listing-evidence-policy.draft",
  "listing-evidence-policy.validate",
  "listing-evidence-policy.view",
  "offers.manage",
  "offers.view",
  "orders.manage",
  "orders.view",
  "payouts.manage",
  "payouts.reconcile",
  "payouts.platform.view",
  "payouts.request",
  "payouts.setup",
  "payouts.view",
  "wallet-adjustments.operate",
  "postage-policies.manage",
  "postage-policies.view",
  "pricing.manage",
  "pricing.view",
  "projection-operations.operate",
  "projection-operations.rebuild",
  "projection-operations.view",
  // Customer feedback operator capabilities. Staff-only: platform-admin
  // is the sole role granted these. `view` reads the operator queue/detail/
  // metrics; `manage` performs triage/notes/review/archive/bulk/follow-up/
  // redaction; `export` is a separate grant so a viewer cannot download the
  // free-text comment corpus unless export is explicitly authorized. Ordinary
  // account roles (owner/manager/fulfillment/viewer) hold none of these --
  // submitting one's own experience feedback is an authenticated-subject
  // authority, not an operator capability.
  "platform-feedback.export",
  "platform-feedback.manage",
  "platform-feedback.view",
  "platform-policy.manage",
  "platform-policy.view",
  "public-presence.manage",
  "public-presence.view",
  "recovered-inventory.evidence",
  "recovered-inventory.manage",
  "recovered-inventory.view",
  "reported-content.view",
  "reputation.manage",
  "reputation.view",
  "support.manage",
  // Customer Feedback attention checks this; no role grants it.
  "support.notify",
  "support.remedies.approve",
  "support.remedies.approve-elevated",
  "support.remedies.correct",
  "support.remedies.override-return",
  "support.remedies.propose",
  "support.remedies.retry",
  "support.remedies.waive",
  "support.view",
  "security.manage",
  // Platform Wallet Adjustment authority ratified by ADR 0020: purpose-specific,
  // never bundled into `payouts.*`, and granted to platform-admin only. Read,
  // create (request), approve (approve/reject), and reverse are independently
  // enforced permissions so each action of the lifecycle can be withheld on
  // its own.
  "wallet-adjustments.approve",
  "wallet-adjustments.create",
  "wallet-adjustments.reverse",
  "wallet-adjustments.view",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_PRESETS = {
  paymentsOperator: ["orders.manage", "orders.view"],
  payoutsOperator: ["payouts.manage", "payouts.reconcile", "payouts.request", "payouts.setup", "payouts.view"],
  payoutsViewer: ["payouts.view"],
} satisfies Readonly<Record<string, readonly PermissionKey[]>>;

/**
 * The one role-to-permission table. Identity's membership projection writes a
 * role's entry into the membership's `role_permissions` snapshot, and Auth
 * resolves a session's permissions as that snapshot united with the role's
 * entry here.
 */
export const ROLE_PERMISSIONS = {
  "platform-admin": [
    "payouts.platform.view",
    "provider-connections.view",
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.agreements.manage",
    "commercial-terms.manage",
    "commercial-terms.view",
    "google-shopping.manage",
    "google-shopping.view",
    "listing-evidence-policy.activate",
    "listing-evidence-policy.draft",
    "listing-evidence-policy.validate",
    "listing-evidence-policy.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "postage-policies.manage",
    "postage-policies.view",
    "return-intake.manage",
    "return-intake.view",
    "projection-operations.operate",
    "projection-operations.rebuild",
    "projection-operations.view",
    // Customer feedback operator capabilities: platform-staff only.
    // Export is a distinct grant from view/manage so the sensitive free-text
    // comment download can be withheld independently.
    "platform-feedback.export",
    "platform-feedback.manage",
    "platform-feedback.view",
    "platform-policy.manage",
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "recovered-inventory.evidence",
    "recovered-inventory.manage",
    "recovered-inventory.view",
    "reported-content.view",
    "security.manage",
    "support.manage",
    "support.remedies.approve",
    "support.remedies.approve-elevated",
    "support.remedies.correct",
    "support.remedies.override-return",
    "support.remedies.propose",
    "support.remedies.retry",
    "support.remedies.waive",
    "support.view",
    // Platform Wallet Adjustment authority (ADR 0020): platform-admin only.
    // Never granted via invitation/membership assignment -- platform-admin
    // itself can only be assigned by platform bootstrap -- and never bundled
    // into payouts.*.
    "wallet-adjustments.approve",
    "wallet-adjustments.create",
    "wallet-adjustments.reverse",
    "wallet-adjustments.view",
  ],
  owner: [
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "channels.manage",
    "channels.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "fulfillment.manage",
    "fulfillment.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "listing-evidence-policy.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "postage-policies.manage",
    "postage-policies.view",
    // Decision #9241 owns whether owner keeps projection-operations.*.
    "projection-operations.operate",
    "projection-operations.rebuild",
    "projection-operations.view",
    ...PERMISSION_PRESETS.payoutsOperator,
    "pricing.manage",
    "pricing.view",
    // Customer feedback operator capabilities are platform-staff only;
    // an account owner does not enumerate/export/mutate platform feedback.
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "reputation.manage",
    "reputation.view",
    "support.manage",
    "support.view",
    "security.manage",
  ],
  manager: [
    "accounts.view",
    "channels.manage",
    "channels.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "fulfillment.manage",
    "fulfillment.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "listing-evidence-policy.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "postage-policies.manage",
    "postage-policies.view",
    ...PERMISSION_PRESETS.payoutsOperator,
    "pricing.manage",
    "pricing.view",
    // Customer feedback operator capabilities are platform-staff only.
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "reputation.manage",
    "reputation.view",
    "support.manage",
    "support.view",
  ],
  fulfillment: [
    "accounts.view",
    "channels.view",
    "fulfillment.manage",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
    "return-intake.manage",
    "return-intake.view",
    // No platform-feedback.* -- operator feedback is platform-staff only.
    "pricing.view",
    "public-presence.view",
    "reputation.view",
    "support.manage",
    "support.view",
  ],
  viewer: [
    "accounts.view",
    "channels.view",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
    ...PERMISSION_PRESETS.payoutsViewer,
    "pricing.view",
    // No platform-feedback.* -- operator feedback is platform-staff only.
    "public-presence.view",
    "reputation.view",
    "support.view",
  ],
} satisfies Readonly<Record<string, readonly PermissionKey[]>>;

/**
 * Commerce permissions Auth withholds from a session whose primary email is not
 * verified. Verifying that email (consuming a magic link does) lifts the
 * restriction on the next actor resolution; nothing else grants them.
 */
export const EMAIL_VERIFICATION_RESTRICTED_PERMISSIONS = [
  "listings.manage",
  "offers.manage",
  "orders.manage",
  "pricing.manage",
] as const satisfies readonly PermissionKey[];

/**
 * True only when the actor's role grants `permission` and Auth withheld it
 * pending email verification, so a surface can truthfully ask the member to
 * verify their email rather than hide the action unexplained. Reads Auth's own
 * role table and grants nothing; agent-scoped actors are never told to verify.
 */
export function permissionAwaitsEmailVerification(
  actor: Pick<ResolvedActor, "roleKey" | "permissions" | "agentGrant"> | null | undefined,
  permission: PermissionKey,
): boolean {
  if (!actor || actor.agentGrant || actor.permissions.includes(permission)) {
    return false;
  }

  const rolePermissions: readonly string[] = ROLE_PERMISSIONS[actor.roleKey as keyof typeof ROLE_PERMISSIONS] ?? [];
  return (
    (EMAIL_VERIFICATION_RESTRICTED_PERMISSIONS as readonly string[]).includes(permission) &&
    rolePermissions.includes(permission)
  );
}

/** Sign-in return marker naming the withheld action a member verifies their email to finish. */
export const EMAIL_VERIFICATION_RETURN_PARAMETER = "verifyEmail";
export type EmailVerificationPurpose = "cancel-purchase";

/**
 * The marketplace sign-in path that emails a magic link and, once the link is
 * consumed (which verifies the email), returns to `returnPath` marked with
 * `purpose`. `returnPath` must be a same-site path; Auth re-validates it.
 */
export function emailVerificationSignInHref(returnPath: string, purpose: EmailVerificationPurpose): string {
  const returnTo = new URL(returnPath, "https://chase-sets.local");
  returnTo.searchParams.set(EMAIL_VERIFICATION_RETURN_PARAMETER, purpose);
  const signIn = new URLSearchParams({
    returnTo: `${returnTo.pathname}${returnTo.search}`,
    signInMethod: "magic-link",
  });
  return `/sign-in?${signIn.toString()}`;
}

export type AgentOAuthScope = AgentOAuthCommerceScope | AgentOAuthOperatorScope;

export type AgentOAuthOperatorScope = "operations:read" | "operations:write";

export type AgentOAuthCommerceScope =
  | "catalog:read"
  | "dev.ucp.shopping.checkout:manage"
  | "dev.ucp.shopping.order:read"
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
  platformProfileUrl: string;
  scopes: readonly AgentOAuthScope[];
  rolePermissions: readonly string[];
}>;

/**
 * The commerce scope families: the only scopes either OAuth metadata
 * document, connector packaging or the developer portal advertises, and the
 * only scopes that map to permissions.
 */
export const AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES = [
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
        scope: "dev.ucp.shopping.checkout:manage",
        label: "Manage checkout",
        description: "Read cart and checkout state, and update it after confirmation.",
        permissions: ["orders.view", "orders.manage"],
      },
    ],
  },
  {
    family: "orders",
    label: "Orders",
    description: "Read purchase and order history.",
    scopes: [
      {
        scope: "dev.ucp.shopping.order:read",
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

/**
 * Operator scopes. `operations:write` implies `operations:read`. They map to
 * no permission, so HTTP and commerce actors never widen: an operator
 * capability is admitted only through the Identity {@link OperatorAuthority},
 * and runs with that authority's role permissions. Never advertised.
 */
export const AGENT_OAUTH_OPERATOR_SCOPE_FAMILY = {
  family: "operations",
  label: "Platform operations",
  description: "Administer Chase Sets while your membership is platform-admin.",
  scopes: [
    {
      scope: "operations:read",
      label: "Read platform operations",
      description: "Run read-only operator tools.",
      permissions: [],
    },
    {
      scope: "operations:write",
      label: "Operate the platform",
      description: "Run every operator tool, including confirmed changes.",
      permissions: [],
    },
  ],
} as const satisfies AgentOAuthScopeFamily;

/** Every family Auth recognizes, for consent and grant labels. Not an advertised list. */
export const AGENT_OAUTH_KNOWN_SCOPE_FAMILIES = [
  ...AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES,
  AGENT_OAUTH_OPERATOR_SCOPE_FAMILY,
] as const satisfies readonly AgentOAuthScopeFamily[];

export const AGENT_OAUTH_COMMERCE_SCOPES = AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES.flatMap((family) =>
  family.scopes.map((scope) => scope.scope),
) as readonly AgentOAuthCommerceScope[];

export const AGENT_OAUTH_OPERATOR_SCOPES = AGENT_OAUTH_OPERATOR_SCOPE_FAMILY.scopes.map(
  (scope) => scope.scope,
) as readonly AgentOAuthOperatorScope[];

const AGENT_OAUTH_SCOPE_SET = new Set<string>([...AGENT_OAUTH_COMMERCE_SCOPES, ...AGENT_OAUTH_OPERATOR_SCOPES]);
const AGENT_OAUTH_OPERATOR_SCOPE_SET = new Set<string>(AGENT_OAUTH_OPERATOR_SCOPES);

export function isAgentOAuthScope(value: unknown): value is AgentOAuthScope {
  return typeof value === "string" && AGENT_OAUTH_SCOPE_SET.has(value);
}

export function isAgentOAuthOperatorScope(value: unknown): value is AgentOAuthOperatorScope {
  return typeof value === "string" && AGENT_OAUTH_OPERATOR_SCOPE_SET.has(value);
}

export function normalizeAgentOAuthScopes(value: unknown): AgentOAuthScope[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  return raw
    .filter(isAgentOAuthScope)
    .filter((scope, index, values) => values.indexOf(scope) === index)
    .sort();
}

export function agentOAuthScopesForPermission(permission: string): readonly AgentOAuthScope[] {
  return AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES.flatMap((family) =>
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
    AGENT_OAUTH_COMMERCE_SCOPE_FAMILIES.flatMap((family) =>
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

export type OperatorAuthorityDenialReason =
  | "no-membership"
  | "inactive"
  | "not-platform-admin"
  | "membership-mismatch"
  | "authority-unavailable";

export type OperatorAuthorityDecision =
  | Readonly<{
      kind: "granted";
      membershipId: string;
      roleKey: "platform-admin";
      rolePermissions: readonly string[];
    }>
  | Readonly<{ kind: "denied"; reason: OperatorAuthorityDenialReason }>;

/**
 * Identity-owned port that decides whether an actor may use operator
 * capabilities. Implementations read the actor's Membership aggregate, never
 * a projection. Consumers treat a thrown error or an absent port as a
 * denial (`authority-unavailable`).
 */
export type OperatorAuthority = (actor: ResolvedActor) => Promise<OperatorAuthorityDecision>;

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
