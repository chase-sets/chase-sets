import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildCheckoutMarketplaceSellerOptionsProjectionHandlers } from "../../cart/integrations/marketplace/marketplace-projection";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as checkoutModule } from "../../../index";
import { sellListAttemptCases } from "./sell-list-attempt.test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Sell List attempt proof.");
(databaseUrl ? describe : describe.skip)(
  "Sell List attempts against real PostgreSQL (lagged confirmation projection is an injected read seam)",
  () => {
    let pools: Readonly<Record<"checkout", PgTransactionalPool>>;
    beforeAll(async () => {
      const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["checkout"], "sell_list_attempt");
      await ensureMultiContextTestDatabases(databaseUrl!, urls);
      pools = createMultiContextTestPools(urls);
    });
    beforeEach(async () => {
      await resetMultiContextTestSchemas(pools);
      await bootstrapContextDatabase(checkoutModule, pools.checkout);
      await pools.checkout.query(
        "INSERT INTO checkout_catalog_items (catalog_item_id, title, status, product_schema, language_code, updated_at) VALUES ('cat_attempt', 'Synthetic Item', 'active', NULL, 'en', now())",
      );
    });
    afterAll(async () => {
      if (pools) await closeMultiContextTestPools(pools);
    });
    sellListAttemptCases(
      () => createPostgresEventStore({ pool: pools.checkout }),
      () => pools.checkout,
    );
    it("preserves evidence freshness for acceptance refresh in PostgreSQL, while meaningful policy drift advances it", async () => {
      const before = "2026-11-06T00:00:00.000Z";
      const after = "2026-11-07T00:00:00.000Z";
      const requirements = { policyHash: "synthetic_policy", policyVersion: 1, requirements: {}, evaluatedAt: before };
      await pools.checkout.query(
        "INSERT INTO checkout_marketplace_seller_options (listing_id, seller_account_id, product_id, catalog_catalog_item_id, price_amount, listing_quantity_cap, status, updated_at, evidence_requirements) VALUES ('lst_refresh', 'acc_seller', 'cat_attempt::', 'cat_attempt', 10, 1, 'active', $1, $2)",
        [before, JSON.stringify(requirements)],
      );
      const handlers = buildCheckoutMarketplaceSellerOptionsProjectionHandlers(pools.checkout);
      const refresh = (snapshot: unknown) =>
        handlers["marketplace.listing.evidence-requirements-refreshed"]!(
          buildTransportEvent(
            "marketplace.listing.evidence-requirements-refreshed",
            { evidenceRequirements: snapshot },
            { streamId: "marketplace.listing-lst_refresh", timing: { occurredAt: after, recordedAt: after } },
          ),
        );
      const read = async () =>
        (
          await pools.checkout.query<{ updated_at: Date; evidence_requirements: unknown }>(
            "SELECT updated_at, evidence_requirements FROM checkout_marketplace_seller_options WHERE listing_id = 'lst_refresh'",
          )
        ).rows[0]!;
      await refresh({ ...requirements, evaluatedAt: after });
      expect((await read()).updated_at.toISOString()).toBe(before);
      expect((await read()).evidence_requirements).toMatchObject({ evaluatedAt: after });
      await refresh({ ...requirements, evaluatedAt: after, policyHash: "synthetic_changed" });
      expect((await read()).updated_at.toISOString()).toBe(after);
    });
  },
);
