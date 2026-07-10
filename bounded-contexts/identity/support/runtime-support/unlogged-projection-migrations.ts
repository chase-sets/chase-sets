import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const identityUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_identity_unlogged_projections",
    description: "Store replayable Identity projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE identity_account_display_name_reservations SET UNLOGGED;",
      "ALTER TABLE identity_accounts SET UNLOGGED;",
      "ALTER TABLE identity_api_key_lookup SET UNLOGGED;",
      "ALTER TABLE identity_api_keys SET UNLOGGED;",
      "ALTER TABLE identity_consents SET UNLOGGED;",
      "ALTER TABLE identity_invitations SET UNLOGGED;",
      "ALTER TABLE identity_memberships SET UNLOGGED;",
      "ALTER TABLE identity_shipping_addresses SET UNLOGGED;",
      "ALTER TABLE identity_user_emails SET UNLOGGED;",
      "ALTER TABLE identity_user_memberships SET UNLOGGED;",
      "ALTER TABLE identity_user_phones SET UNLOGGED;",
      "ALTER TABLE identity_user_preferences SET UNLOGGED;",
      "ALTER TABLE identity_user_social_login_links SET UNLOGGED;",
      "ALTER TABLE identity_users SET UNLOGGED;",
    ],
  },
];
