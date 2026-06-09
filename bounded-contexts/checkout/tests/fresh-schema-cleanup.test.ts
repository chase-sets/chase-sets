import { describe, expect, it } from "vitest";

import { checkoutCatalogProjectionSchemaSql } from "../features/cart/integrations/catalog/catalog-schema";
import { checkoutCartSchemaSql } from "../features/cart/read-model/schema";
import { checkoutSellListSchemaSql } from "../features/sell-list/read-model/schema";
import { checkoutSessionSchemaSql } from "../features/sessions/read-model/schema";

const checkoutSchemaSql = [
  checkoutCatalogProjectionSchemaSql,
  checkoutCartSchemaSql,
  checkoutSellListSchemaSql,
  checkoutSessionSchemaSql,
].join("\n");

describe("fresh checkout read-model schemas", () => {
  it("keeps final checkout columns in base schemas instead of compatibility patches", () => {
    expect(checkoutSchemaSql).not.toMatch(/ADD COLUMN IF NOT EXISTS/i);

    expect(checkoutCartSchemaSql).toContain("item_image_url text NULL");
    expect(checkoutCartSchemaSql).toContain("fulfillment_mode text NOT NULL DEFAULT 'optimize'");
    expect(checkoutCartSchemaSql).toContain("item_language_code text NULL");

    expect(checkoutCatalogProjectionSchemaSql).toContain("language_code text NOT NULL DEFAULT 'en'");
    expect(checkoutCatalogProjectionSchemaSql).toContain(
      `label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb`,
    );

    expect(checkoutSessionSchemaSql).toContain("shipping_address_id text NULL");
    expect(checkoutSessionSchemaSql).toContain("fulfillment_preview_revision text NULL");
    expect(checkoutSessionSchemaSql).toContain("cart_readiness_snapshot jsonb NULL");
  });

  it("uses only the canonical Sell List execution receipt read model", () => {
    expect(checkoutSellListSchemaSql).toContain("checkout_sell_list_execution_receipt_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_receipt_pages (");
  });
});
