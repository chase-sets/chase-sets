import type { BcRetentionExemption, BcRetentionSweep, BcSchemaMigration } from "@chase-sets/bounded-context-module";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const authRetentionSweeps: readonly BcRetentionSweep[] = [
  expired("sessions", "identity_sessions"),
  expired("session-lookup", "identity_session_lookup"),
  // Deleting expired magic-link rows is the retention half of the PII policy
  // from #3471; no separate plaintext-nulling pass is needed before row death.
  expired("magic-link-tokens", "identity_magic_link_tokens"),
  // The same row-death rule removes unconsumed delivery_code plaintext.
  expired("phone-code-tokens", "identity_phone_code_tokens"),
  expired("auth-challenges", "identity_auth_challenges"),
  expired("session-tokens", "identity_session_tokens"),
  expired("account-selection-tokens", "identity_account_selection_tokens"),
  expired("social-login-states", "identity_social_login_states"),
  expired("guest-checkout-tokens", "identity_guest_checkout_tokens"),
  expired("guest-checkout-claim-tokens", "identity_guest_checkout_claim_tokens"),
  expired("ucp-oauth-authorization-codes", "identity_ucp_oauth_authorization_codes"),
];

export const authRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "auth_identity_invitations",
    owner: "auth",
    reason: "This mutable Identity projection must remain available for later invitation lifecycle events.",
  },
];

export const authRetentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_auth_retention_indexes",
    description: "Add expiry indexes used by bounded Auth retention sweeps.",
    statements: [
      ...[
        "identity_sessions",
        "identity_session_lookup",
        "identity_magic_link_tokens",
        "identity_phone_code_tokens",
        "identity_auth_challenges",
        "identity_session_tokens",
        "identity_account_selection_tokens",
        "identity_social_login_states",
        "identity_guest_checkout_tokens",
        "identity_guest_checkout_claim_tokens",
      ].map(
        (tableName) =>
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${tableName}_retention_idx ON ${tableName} (expires_at)`,
      ),
    ],
  },
];

function expired(name: string, tableName: string): BcRetentionSweep {
  return {
    name: `expired-${name}`,
    tableName,
    predicateSql: "candidate.expires_at < now() - interval '7 days'",
    orderBySql: "candidate.expires_at ASC",
    intervalMs: DAY_MS,
    batchLimit: 500,
  };
}
