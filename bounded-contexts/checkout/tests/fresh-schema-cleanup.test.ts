import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkoutCatalogProjectionSchemaSql } from "../features/cart/integrations/catalog/catalog-schema";
import { checkoutCartSchemaSql } from "../features/cart/read-model/schema";
import { checkoutSellListSchemaSql } from "../features/sell-list/read-model/schema";
import { checkoutSessionSchemaSql } from "../features/sessions/read-model/schema";

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
          routeId: "sell-checkout-session",
          routePath: "checkout/sell/session/:sessionId",
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

  it("keeps customer-facing checkout surfaces free of dense legacy and repair copy", () => {
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
      { label: "legacy checkout copy", pattern: /\blegacy checkout\b/i },
      { label: "old checkout copy", pattern: /\bold checkout\b/i },
      { label: "dense checkout fallback copy", pattern: /\bdense checkout fallback\b/i },
      { label: "compatibility adapter copy", pattern: /\bcompatibility adapter\b/i },
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
      "docs/architecture/checkout-surface-audit.md",
      "docs/architecture/cookie-backed-continuation-handoff.md",
      "docs/architecture/projection-freshness-slos.md",
      "docs/architecture/projection-freshness-worker-capacity.md",
      "docs/architecture/read-after-write-route-author-checklist.md",
      "docs/runbooks/guest-buy-now-freshness-canary.md",
      "docs/runbooks/guest-buy-now-projection-lag-root-cause.md",
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
