import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const authUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_auth_unlogged_projections",
    description: "Store replayable Auth projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE auth_identity_accounts SET UNLOGGED;",
      "ALTER TABLE auth_identity_invitations SET UNLOGGED;",
      "ALTER TABLE auth_identity_memberships SET UNLOGGED;",
      "ALTER TABLE auth_identity_user_emails SET UNLOGGED;",
      "ALTER TABLE auth_identity_user_memberships SET UNLOGGED;",
      "ALTER TABLE auth_identity_user_phones SET UNLOGGED;",
      "ALTER TABLE auth_identity_user_social_login_links SET UNLOGGED;",
      "ALTER TABLE auth_identity_users SET UNLOGGED;",
      "ALTER TABLE identity_session_lookup SET UNLOGGED;",
      "ALTER TABLE identity_sessions SET UNLOGGED;",
    ],
  },
];
