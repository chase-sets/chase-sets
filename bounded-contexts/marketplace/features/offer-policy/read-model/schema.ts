import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const tables = `
CREATE UNLOGGED TABLE IF NOT EXISTS marketplace_buyer_offer_policy_pages (
  policy_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  state jsonb NOT NULL,
  last_stream_version integer NOT NULL
);
CREATE UNLOGGED TABLE IF NOT EXISTS marketplace_buyer_offer_policy_memberships (
  offer_id text PRIMARY KEY,
  policy_id text NOT NULL,
  buyer_account_id text NOT NULL
);`;
export const marketplaceBuyerOfferPolicySchemaSql = `${tables}
CREATE INDEX IF NOT EXISTS marketplace_buyer_offer_policy_account_idx
  ON marketplace_buyer_offer_policy_pages (buyer_account_id, policy_id);
CREATE INDEX IF NOT EXISTS marketplace_buyer_offer_policy_membership_idx
  ON marketplace_buyer_offer_policy_memberships (policy_id, offer_id);
`;
export const marketplaceBuyerOfferPolicySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260927_marketplace_buyer_offer_policy",
    description: "Install private, replayable Buyer Offer Policy summaries and permanent Offer memberships.",
    statements: [
      tables,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_buyer_offer_policy_account_idx ON marketplace_buyer_offer_policy_pages (buyer_account_id, policy_id);",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_buyer_offer_policy_membership_idx ON marketplace_buyer_offer_policy_memberships (policy_id, offer_id);",
    ],
  },
];
