import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { generateSyntheticProviderObservationFixture } from "../../price-signals/tests/fixtures/provider-observations/generate-fixture";
import { commitProviderObservationCapture } from "../../price-signals/read-model/provider-observation-writes";

export async function seedDemandCurveParityFixture(pool: PgTransactionalPool) {
  const { capture } = generateSyntheticProviderObservationFixture();
  const catalogItemId = capture.header.catalogItemId;
  const builtAt = capture.header.captureStartedAt;
  await commitProviderObservationCapture(pool, capture);
  const identities = ["Near Mint", "Lightly Played"].map((condition, index) => ({
    catalogItemId,
    productId: `${catalogItemId}::synthetic-freshness-${index}`,
    condition,
  }));
  for (const [index, identity] of identities.entries()) {
    await pool.query(
      `INSERT INTO pricing_external_weekly_sale_buckets
       (provider_key,external_key,catalog_item_id,catalog_product_key,week_start,provider_condition,provider_variant,
        provider_language,transaction_count,quantity_sold,last_capture_id,last_observed_at,updated_at)
       VALUES ('tcgplayer',$1,$2,$3,'2026-08-31',$4,'Normal','English',1,1,$5,$6,$6)`,
      [
        `sku:synthetic-freshness-${index}`,
        catalogItemId,
        identity.productId,
        identity.condition,
        capture.header.captureId,
        builtAt,
      ],
    );
  }
  return { builtAt, identities };
}
