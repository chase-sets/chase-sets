import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const publicPresenceUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_public_presence_unlogged_projections",
    description: "Store replayable Public Presence projections as unlogged tables.",
    statements: ["SET lock_timeout = '5s';", "ALTER TABLE public_presence_waitlist_signups SET UNLOGGED;"],
  },
];
