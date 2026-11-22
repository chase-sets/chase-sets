import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { DiscoveryPublicAccount } from "../../../support/client-support/contracts";
import { buildDiscoveryMarketProjectionHandlers } from "../../../support/market-support/projection";

export async function projectRedactedPublicAccount(account: DiscoveryPublicAccount) {
  const db: PgQueryable = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("INSERT INTO discovery_market_accounts")) {
        account.account_slug = String(values[1]);
        account.account_display_name = String(values[2]);
        account.listings[0]!.seller_display_name = String(values[2]);
        return { rows: [{ status: account.status }] as Row[] };
      }
      if (sql.includes("SELECT seller_slug")) return { rows: [{ seller_slug: account.account_slug }] as Row[] };
      if (sql.includes("RETURNING outbox_id")) return { rows: [{ outbox_id: 1 }] as Row[] };
      return { rows: [] };
    },
  };
  const type = "identity.account.profile-updated";
  await buildDiscoveryMarketProjectionHandlers(db)[type]!(
    buildTransportEvent(
      type,
      { name: "North Store LLC", displayName: "Name removed" },
      { streamId: `identity.account-${account.account_id}` },
    ),
  );
}
