import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkoutCatalogProjectionSchemaSql } from "../features/cart/integrations/catalog/catalog-schema";
import { checkoutInventorySupplySchemaSql } from "../features/cart/integrations/inventory/inventory-schema";
import {
  checkoutMarketplaceSellerOptionsSchemaMigrations,
  checkoutMarketplaceSellerOptionsSchemaSql,
} from "../features/cart/integrations/marketplace/marketplace-schema";
import { checkoutCartSchemaSql } from "../features/cart/read-model/schema";
import { checkoutSellListSchemaSql } from "../features/sell-list/read-model/schema";
import { checkoutSessionSchemaMigrations, checkoutSessionSchemaSql } from "../features/sessions/read-model/schema";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(checkoutRoot, "..", "..");
type ForbiddenPattern = Readonly<{
  label: string;
  pattern: RegExp;
}>;

function collectFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root)
    .flatMap((entry) => {
      const absolute = join(root, entry);
      const stats = statSync(absolute);

      if (stats.isDirectory()) {
        return collectFiles(absolute);
      }

      return /\.(ts|tsx)$/.test(entry) && !entry.includes(".test.") ? [absolute] : [];
    })
    .sort();
}

function readText(file: string) {
  return readFileSync(file, "utf8");
}

function repoRelative(file: string) {
  return relative(repoRoot, file).replace(/\\/g, "/");
}

function assertNoPatterns(files: readonly string[], patterns: readonly ForbiddenPattern[]) {
  const failures = files.flatMap((file) => {
    const text = readText(file);
    return patterns
      .filter(({ pattern }) => pattern.test(text))
      .map(({ label }) => `${repoRelative(file)} contains ${label}`);
  });

  expect(failures).toEqual([]);
}

describe("fresh checkout read-model schemas", () => {
  it("keeps final checkout columns in base schemas with only explicit active schema evolution", () => {
    const cartAddColumns = [...checkoutCartSchemaSql.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)].map(
      ([, column]) => column,
    );

    expect(cartAddColumns).toEqual([
      "selected_listing_id",
      "selected_listing_seller_account_id",
      "selected_listing_seller_display_name",
      "selected_listing_seller_slug",
      "selected_listing_price_amount",
      "selected_listing_snapshot_source",
      "selected_listing_snapshot_captured_at",
    ]);
    expect(checkoutSellListSchemaSql).not.toMatch(/ADD COLUMN IF NOT EXISTS/i);
    const sessionAddColumns = [...checkoutSessionSchemaSql.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)].map(
      ([, column]) => column,
    );
    expect(sessionAddColumns).toEqual(["order_write_commit_positions", "fulfillment_preview_snapshot"]);

    expect(checkoutCartSchemaSql).toContain("item_image_url text NULL");
    expect(checkoutCartSchemaSql).toContain("fulfillment_mode text NOT NULL DEFAULT 'optimize'");
    expect(checkoutCartSchemaSql).toContain("item_language_code text NULL");

    expect(checkoutCatalogProjectionSchemaSql).toContain("language_code text NOT NULL DEFAULT 'en'");
    expect(checkoutCatalogProjectionSchemaSql).toContain(
      `label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb`,
    );

    expect(checkoutSessionSchemaSql).toContain("shipping_address_id text NULL");
    expect(checkoutSessionSchemaSql).toContain("fulfillment_preview_revision text NULL");
    expect(checkoutSessionSchemaSql).toContain("fulfillment_preview_snapshot jsonb NULL");
    expect(checkoutSessionSchemaSql).toContain("cart_readiness_snapshot jsonb NULL");
    expect(checkoutSessionSchemaSql).toContain("submitted_offer_id text NULL");
    expect(checkoutSessionSchemaSql).toContain("order_write_commit_positions jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(checkoutSessionSchemaSql).toContain("checkout_reservations jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(checkoutSessionSchemaSql).not.toContain("ADD COLUMN IF NOT EXISTS checkout_reservations");
    expect(checkoutSessionSchemaMigrations).toEqual([
      expect.objectContaining({
        migrationId: "20260707_checkout_session_reservations",
        // A single metadata-only ADD COLUMN ... NOT NULL DEFAULT avoids the ACCESS EXCLUSIVE
        // full-table scan that hung bootstrap under live traffic (#4638).
        statements: [
          expect.stringContaining("ADD COLUMN IF NOT EXISTS checkout_reservations jsonb NOT NULL DEFAULT '[]'::jsonb"),
        ],
      }),
    ]);
    expect(checkoutSessionSchemaMigrations[0]?.statements).toHaveLength(1);
    expect(checkoutSessionSchemaMigrations[0]?.statements.join("\n")).not.toMatch(/SET NOT NULL/);
  });

  it("keeps checkout inventory schema evolution before indexes that use evolved columns", () => {
    const locationEvolution = checkoutInventorySupplySchemaSql.indexOf("ALTER TABLE checkout_supply_locations");
    const locationAccountIndex = checkoutInventorySupplySchemaSql.indexOf(
      "CREATE INDEX IF NOT EXISTS checkout_supply_locations_account_idx",
    );
    const itemEvolution = checkoutInventorySupplySchemaSql.indexOf("ALTER TABLE checkout_supply_items");
    const itemAccountIndex = checkoutInventorySupplySchemaSql.indexOf(
      "CREATE INDEX IF NOT EXISTS checkout_supply_items_account_idx",
    );

    expect(locationEvolution).toBeGreaterThanOrEqual(0);
    expect(locationEvolution).toBeLessThan(locationAccountIndex);
    expect(checkoutInventorySupplySchemaSql).toContain("ADD COLUMN IF NOT EXISTS account_id text NULL");
    expect(checkoutInventorySupplySchemaSql).toContain("ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''");
    expect(checkoutInventorySupplySchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS ship_from_code text NOT NULL DEFAULT ''",
    );
    expect(itemEvolution).toBeGreaterThanOrEqual(0);
    expect(itemEvolution).toBeLessThan(itemAccountIndex);
  });

  it("keeps hot seller-option projection indexes as concurrent schema migrations", () => {
    const statements = checkoutMarketplaceSellerOptionsSchemaMigrations.flatMap((migration) => migration.statements);

    expect(checkoutMarketplaceSellerOptionsSchemaSql).not.toContain(
      "checkout_marketplace_seller_options_inventory_item_idx",
    );
    expect(checkoutMarketplaceSellerOptionsSchemaSql).not.toContain(
      "checkout_marketplace_seller_options_catalog_item_idx",
    );
    expect(checkoutMarketplaceSellerOptionsSchemaSql).not.toContain(
      "checkout_marketplace_seller_options_seller_availability_idx",
    );
    expect(statements).toEqual([
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_marketplace_seller_options_inventory_item_idx",
      ),
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_marketplace_seller_options_catalog_item_idx",
      ),
      expect.stringContaining(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_marketplace_seller_options_seller_availability_idx",
      ),
    ]);
    expect(statements[0]).toContain("ON checkout_marketplace_seller_options (inventory_item_id)");
    expect(statements[1]).toContain("ON checkout_marketplace_seller_options (catalog_catalog_item_id)");
    expect(statements[2]).toContain("ON checkout_marketplace_seller_options (seller_account_id, status)");
    expect(statements[2]).toContain("WHERE status IN ('active', 'seller-unavailable')");
  });

  it("uses the fresh Sell List confirmation read model without execution receipts", () => {
    expect(checkoutSellListSchemaSql).toContain("checkout_sell_list_confirmation_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_execution_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_execution_receipt_pages");
    expect(checkoutSellListSchemaSql).not.toContain("checkout_sell_list_receipt_pages (");
  });

  it("declares Sell List API routes as fresh reads of Sell List pages", () => {
    const manifest = JSON.parse(readText(join(checkoutRoot, "context.json"))) as {
      apiMounts?: Array<{
        mountPath?: string;
        readFreshnessRoutes?: Array<{
          routePath?: string;
          methods?: string[];
          dependencies?: Array<{ readModelTable?: string }>;
        }>;
      }>;
    };
    const marketplaceApi = manifest.apiMounts?.find((mount) => mount.mountPath === "/api/marketplace");

    expect(marketplaceApi?.readFreshnessRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routePath: "/account/sell-list",
          methods: ["GET", "HEAD"],
          dependencies: [
            { readModelTable: "checkout_sell_list_line_pages" },
            { readModelTable: "checkout_sell_list_confirmation_pages" },
            { readModelTable: "checkout_sell_payout_readiness_pages" },
            { readModelTable: "checkout_sell_offer_pages" },
            { readModelTable: "checkout_marketplace_seller_options" },
            { readModelTable: "checkout_supply_items" },
            { readModelTable: "checkout_supply_locations" },
            { readModelTable: "checkout_seller_accounts" },
            { readModelTable: "checkout_ship_from_addresses" },
          ],
        }),
        expect.objectContaining({
          routePath: "/guest/sell-list",
          methods: ["GET", "HEAD"],
          dependencies: [{ readModelTable: "checkout_sell_list_line_pages" }],
        }),
      ]),
    );
  });

  it("subscribes Checkout Session events for the fresh session detail read model", () => {
    const manifest = JSON.parse(readText(join(checkoutRoot, "context.json"))) as {
      eventSubscriptions?: Array<{
        sourceContextName?: string;
        projectionName?: string;
        eventTypes?: string[];
        projectionHandlerSetNames?: string[];
      }>;
      apiMounts?: Array<{
        mountPath?: string;
        readFreshnessRoutes?: Array<{
          routePath?: string;
          dependencies?: Array<{ readModelTable?: string }>;
        }>;
      }>;
    };
    const marketplaceApi = manifest.apiMounts?.find((mount) => mount.mountPath === "/api/marketplace");
    const sessionFreshRead = marketplaceApi?.readFreshnessRoutes?.find(
      (route) => route.routePath === "/account/checkout-sessions/:sessionId",
    );

    expect(sessionFreshRead?.dependencies).toEqual([{ readModelTable: "checkout_session_pages" }]);
    expect(manifest.eventSubscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceContextName: "checkout",
          projectionName: "checkout.session-projection",
          eventTypes: [
            "checkout.session.started",
            "checkout.session.optimization-goal-selected",
            "checkout.session.fulfillment-preview-recorded",
            "checkout.session.shipping-option-selected",
            "checkout.session.shipping-address-set",
            "checkout.session.reservations-recorded",
            "checkout.session.orders-created",
            "checkout.session.payment-started",
            "checkout.session.offer-submitted",
          ],
          projectionHandlerSetNames: ["checkout.session-projection"],
        }),
      ]),
    );
  });

  it("exposes only fresh buy checkout route paths in customer route composition", () => {
    const manifest = JSON.parse(readText(join(checkoutRoot, "context.json"))) as {
      deployableContributions?: Array<{
        deployable?: string;
        routes?: Array<{ routeId?: string; routePath?: string; fileExport?: string }>;
      }>;
    };
    const marketplaceRoutes =
      manifest.deployableContributions
        ?.filter((contribution) => contribution.deployable === "marketplace-web")
        .flatMap((contribution) => contribution.routes ?? []) ?? [];

    expect(marketplaceRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "buy-checkout-readiness",
          routePath: "checkout/buy/readiness",
          fileExport: "./routes/checkout-start",
        }),
        expect.objectContaining({
          routeId: "buy-checkout-session",
          routePath: "checkout/buy/session/:sessionId",
          fileExport: "./routes/checkout-session",
        }),
        expect.objectContaining({
          routeId: "buy-checkout-confirmation",
          routePath: "checkout/buy/session/:sessionId/confirmation",
          fileExport: "./routes/buy-checkout-confirmation",
        }),
        expect.objectContaining({
          routeId: "sell-checkout-session",
          routePath: "checkout/sell/session/:sessionId",
        }),
        expect.objectContaining({
          routeId: "sell-checkout-confirmation",
          routePath: "checkout/sell/session/:sessionId/confirmation",
          fileExport: "./routes/sell-checkout-confirmation",
        }),
      ]),
    );
    expect(marketplaceRoutes.map((route) => route.routeId)).not.toEqual(
      expect.arrayContaining(["checkout-start", "checkout-session", "checkout-concept"]),
    );
    expect(marketplaceRoutes.map((route) => route.routePath)).not.toEqual(
      expect.arrayContaining(["checkout/start", "checkout/:sessionId", "checkout/concept"]),
    );
  });

  it("keeps customer-facing checkout surfaces free of dense old-flow and repair copy", () => {
    const customerFacingFiles = [
      ...collectFiles(join(checkoutRoot, "features", "cart", "ui")),
      ...collectFiles(join(checkoutRoot, "features", "sell-list", "ui")),
      ...collectFiles(join(checkoutRoot, "features", "sessions", "ui")),
      ...collectFiles(join(checkoutRoot, "routes")),
      ...collectFiles(join(repoRoot, "bounded-contexts", "discovery", "routes")),
      join(repoRoot, "contracts", "localization", "locales", "en", "checkout.ts"),
    ];
    const forbiddenCustomerCopy: readonly ForbiddenPattern[] = [
      { label: "old buy checkout start route", pattern: /\/checkout\/start|checkout\/start/ },
      { label: "old broad checkout session route", pattern: /\/checkout\/:sessionId|checkout\/:sessionId/ },
      { label: "old checkout copy", pattern: /\bold checkout\b/i },
      { label: "dense checkout fallback copy", pattern: /\bdense checkout fallback\b/i },
      { label: "adapter copy", pattern: /\badapter\b/i },
      { label: "migration or backfill copy", pattern: /\bmigration\/backfill\b|\bmigration\b|\bbackfill\b/i },
      { label: "hidden repair copy", pattern: /\bhidden repair\b/i },
      { label: "provider payload copy", pattern: /\bprovider payload\b/i },
      { label: "proof-mode helper copy", pattern: /\bproof mode\b|\bproof-mode\b|\bproof flow\b/i },
      {
        label: "diagnostic helper copy",
        pattern: /\bdiagnostic helper\b|\braw diagnostic\b|\bprovider diagnostics\b/i,
      },
      { label: "webhook replay helper copy", pattern: /\bwebhook replay\b/i },
      { label: "manual database edit copy", pattern: /\bmanual database edit\b/i },
      { label: "selected seller listing copy", pattern: /\bselected seller listing\b/i },
      { label: "stale read model copy", pattern: /\bstale read model\b/i },
    ];

    assertNoPatterns(customerFacingFiles, forbiddenCustomerCopy);
  });

  it("keeps current-flow docs and runbooks on fresh buy route names", () => {
    const currentFlowDocs = [
      "bounded-contexts/checkout/docs/guest-buy-now-freshness-verification.md",
      "docs/architecture/cookie-backed-continuation-handoff.md",
      "docs/architecture/projection-freshness-slos.md",
      "docs/architecture/projection-freshness-worker-capacity.md",
      "docs/architecture/read-after-write-route-author-checklist.md",
      "docs/runbooks/guest-buy-now-freshness-probe.md",
      "docs/runbooks/projection-freshness-audit.md",
      "docs/runbooks/push-wake-operations.md",
    ].map((file) => join(repoRoot, file));
    const oldRoutePatterns: readonly ForbiddenPattern[] = [
      { label: "old buy checkout start route", pattern: /\/checkout\/start|checkout\/start|`checkout-start`/ },
      {
        label: "old broad checkout session route",
        pattern: /\/checkout\/:sessionId|checkout\/:sessionId|`checkout-session`/,
      },
    ];

    assertNoPatterns(currentFlowDocs, oldRoutePatterns);
  });

  it("does not keep checkout deferred-payment helper localization", () => {
    const localization = readText(join(repoRoot, "contracts", "localization", "locales", "en", "checkout.ts"));

    expect(localization).not.toContain("deferred.checkout.order.proof.required");
  });
});
