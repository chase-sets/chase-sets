import { describe, expect, it } from "vitest";

import { checkoutCatalogProjectionSchemaSql } from "../features/cart/integrations/catalog/catalog-schema";
import { checkoutCartSchemaSql } from "../features/cart/read-model/schema";
import { checkoutSellListSchemaSql } from "../features/sell-list/read-model/schema";
import { checkoutSessionSchemaSql } from "../features/sessions/read-model/schema";

describe("fresh checkout read-model schemas", () => {
  it("keeps final checkout columns in base schemas with only deploy-safe session convergence", () => {
    expect(checkoutCartSchemaSql).not.toMatch(/ADD COLUMN IF NOT EXISTS/i);
    expect(checkoutSellListSchemaSql).not.toMatch(/ADD COLUMN IF NOT EXISTS/i);

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
    expect(checkoutSessionSchemaSql).toContain("ALTER TABLE checkout_session_pages");
    expect(checkoutSessionSchemaSql).toContain("ADD COLUMN IF NOT EXISTS buyer_account_id text NOT NULL DEFAULT ''");
    expect(checkoutSessionSchemaSql).toContain("ADD COLUMN IF NOT EXISTS cart_readiness_snapshot jsonb NULL");
    expect(checkoutSessionSchemaSql).toContain("ADD COLUMN IF NOT EXISTS submitted_offer_id text NULL");
  });

  it("uses the fresh Sell List confirmation read model without execution receipts", () => {
    expect(checkoutSellListSchemaSql).toContain("checkout_sell_list_confirmation_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_execution_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_execution_receipt_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_receipt_pages (");
  });
});
