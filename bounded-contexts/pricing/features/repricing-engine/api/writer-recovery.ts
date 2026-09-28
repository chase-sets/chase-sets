import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PricingListingAuthorityWriters } from "./listing-authority-writers";

export function createPricingWriterRecovery(db: PgQueryable, writers: PricingListingAuthorityWriters) {
  const pages = {
    event: writers.authority.recover,
    product: writers.productRounds.recover,
    activation: writers.repricingPolicies.recoverAuthorityMutations,
  };
  return async () => {
    const results = [];
    for (const [writer, recover] of Object.entries(pages)) {
      const cursor = await db.query<{ after_position: string }>(
        "SELECT after_position::text FROM pricing_authority_recovery_cursors WHERE writer = $1",
        [writer],
      );
      const after = cursor.rows[0]?.after_position ?? "0";
      const result = await recover({ after, limit: 25 });
      const next = "nextCursor" in result ? (result.nextCursor ?? "0") : result.after;
      // Cursors discover work, never authorize it. Wrap each independently so unresolved earlier work is retried.
      await db.query(
        `INSERT INTO pricing_authority_recovery_cursors (writer, after_position) VALUES ($1, $2::bigint)
         ON CONFLICT (writer) DO UPDATE SET after_position = EXCLUDED.after_position`,
        [writer, next === after ? "0" : next],
      );
      results.push({ writer, ...result });
    }
    return results;
  };
}
