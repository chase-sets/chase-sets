import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";

const registeredCallers = new Map([
  [
    "bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts",
    ["priceCurrencyCode: review.fallbackListing.priceCurrencyCode"],
  ],
  [
    "bounded-contexts/discovery/support/route-support/item-detail/action.ts",
    ['const priceCurrencyCode = String(formData.get("priceCurrencyCode") ?? "")', "priceCurrencyCode,"],
  ],
  [
    "bounded-contexts/inventory/features/import-batches/api/runtime.ts",
    ["priceCurrencyCode: row.listing_price_currency_code"],
  ],
  [
    "bounded-contexts/marketplace/features/listings/api/mcp.ts",
    ["priceCurrencyCode: readRequiredPriceCurrencyCode(args)"],
  ],
  [
    "bounded-contexts/marketplace/features/listings/api/route.ts",
    ["assertPriceCurrencyInput(body.priceCurrencyCode)", "assertPriceCurrencyInput(priceCurrencyCode)"],
  ],
  [
    "bounded-contexts/marketplace/features/listings/api/runtime.ts",
    ["priceCurrencyCode: params.priceCurrencyCode", "priceCurrencyCode: update.priceCurrencyCode"],
  ],
  ["bounded-contexts/marketplace/routes/account-listing.tsx", ["priceCurrencyCode: priceDraftCurrencyCode"]],
  ["bounded-contexts/marketplace/routes/account-listings-new.tsx", ["priceCurrencyCode: createForm.priceCurrencyCode"]],
  ["bounded-contexts/marketplace/support/runtime-support/seed.ts", ["priceCurrencyCode: listing.priceCurrencyCode"]],
  [
    "bounded-contexts/pricing/features/bulk-reprice-ingestion/api/runtime.ts",
    ["priceCurrencyCode: listing.price_currency_code"],
  ],
  [
    "bounded-contexts/pricing/features/recommendations/api/runtime.ts",
    ["priceCurrencyCode: row.current_price_currency_code", "priceCurrencyCode: row.market_currency"],
  ],
  [
    "bounded-contexts/pricing/features/repricing-engine/api/runtime.ts",
    ["priceCurrencyCode: entry.listing.priceCurrencyCode"],
  ],
  ["bounded-contexts/pricing/support/request-support/marketplace-listings.ts", ["PricingMarketplaceListingGateway"]],
  ["contracts/catalog-seed/representative-commerce-state.ts", ["priceCurrencyCode: string"]],
  ["deployables/platform-api/src/app.ts", ["InventoryDraftListingCreator"]],
  ["deployables/platform-worker/src/main.ts", ["MarketplaceListingServices", "InventoryDraftListingCreator"]],
]);

function source(file) {
  return readFileSync(path.join(repoRoot, ...file.split("/")), "utf8");
}

function sourceDerivedCallers() {
  const tracked = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file));
  const authoringCall =
    /\.(?:createListing|createListingFromInventorySnapshot|createBatchDraftListingFromInventorySnapshot|createAnonymousListingDraftIntent|updateListingPrice|applyBulkListingPriceUpdates)\s*\(/;
  return tracked.filter((file) => authoringCall.test(source(file)) && source(file).includes("priceAmount"));
}

describe("marketplace-listing-price-pair-caller-closure", () => {
  it("registers every source-derived production authoring caller", () => {
    const unregistered = sourceDerivedCallers().filter((file) => !registeredCallers.has(file));
    expect(unregistered).toEqual([]);
  });

  it.each([...registeredCallers.entries()])("keeps explicit currency evidence in %s", (file, evidence) => {
    const text = source(file);
    for (const fragment of evidence) expect(text).toContain(fragment);
    expect(text).not.toMatch(/priceCurrencyCode\s*[:=][^\r\n]*(?:\?\?|\|\|)\s*["']USD["']/);
  });
});
