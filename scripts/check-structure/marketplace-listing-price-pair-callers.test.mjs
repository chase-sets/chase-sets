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

const registeredOfferCallers = new Map([
  [
    "bounded-contexts/marketplace/features/offers/api/mcp.ts",
    ['priceCurrencyCode: readRequiredString(args, "priceCurrencyCode")'],
  ],
  ["bounded-contexts/marketplace/features/offers/api/route.ts", ["priceCurrencyCode: String(body.priceCurrencyCode"]],
  ["contracts/catalog-seed/representative-commerce-state.ts", ["priceCurrencyCode: string"]],
]);

const registeredBuyNowPriceHandoffs = new Map([
  [
    "bounded-contexts/discovery/routes/public-listing.tsx",
    ["priceAmount: listing.price_amount", 'priceCurrencyCode: listing.price_currency_code ?? ""'],
  ],
  [
    "bounded-contexts/discovery/support/route-support/item-detail/action.ts",
    ['priceAmount: lockedListing?.price_amount ?? ""', 'priceCurrencyCode: lockedListing?.price_currency_code ?? ""'],
  ],
  [
    "bounded-contexts/checkout/features/sessions/ui/checkout-start-page-types.ts",
    ["priceAmount: string | null", "priceCurrencyCode: string | null"],
  ],
  [
    "bounded-contexts/checkout/support/route-support/buy-checkout-readiness/checkout-start-source.ts",
    [
      'priceCurrencyCode: url.searchParams.get("priceCurrencyCode") || null',
      'priceCurrencyCode: String(formData.get("priceCurrencyCode") ?? "") || null',
    ],
  ],
  [
    "bounded-contexts/checkout/features/sessions/ui/checkout-start-summary.tsx",
    [
      'name="priceCurrencyCode"',
      "source.priceAmount && source.priceCurrencyCode",
      "formatMoney(source.priceAmount, source.priceCurrencyCode)",
    ],
  ],
]);

const versionedConsumerRoots = [
  "bounded-contexts/checkout/",
  "bounded-contexts/discovery/",
  "bounded-contexts/ordering/",
  "bounded-contexts/platform-operations/",
  "bounded-contexts/pricing/",
  "bounded-contexts/settlement/",
];

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

function sourceDerivedOfferCallers() {
  return productionTypescriptFiles().filter((file) => {
    const text = source(file);
    return /\.(?:submitOffer|updateOfferPrice)\s*\(/.test(text) && text.includes("priceAmount");
  });
}

function productionTypescriptFiles() {
  return execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file));
}

function sourceDerivedVersionedPairConsumers() {
  const eventName = /marketplace\.(?:listing\.(?:created|price-updated)|offer\.(?:submitted|price-updated|accepted))/;
  return productionTypescriptFiles().filter((file) => {
    if (!versionedConsumerRoots.some((root) => file.startsWith(root))) return false;
    const text = source(file);
    return eventName.test(text) && /priceAmount|price_amount/.test(text);
  });
}

function sourceDerivedBuyNowPriceProducers() {
  return productionTypescriptFiles().filter((file) => {
    const text = source(file);
    return (
      text.includes("/checkout/buy/readiness") && text.includes('source: "buy-now"') && text.includes("priceAmount")
    );
  });
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

  it("registers every source-derived production Offer authoring caller", () => {
    const unregistered = sourceDerivedOfferCallers().filter((file) => !registeredOfferCallers.has(file));
    expect(unregistered).toEqual([]);
  });

  it.each([...registeredOfferCallers.entries()])("keeps buyer-authored currency evidence in %s", (file, evidence) => {
    const text = source(file);
    for (const fragment of evidence) expect(text).toContain(fragment);
    expect(text).not.toMatch(/priceCurrencyCode\s*[:=][^\r\n]*(?:\?\?|\|\|)\s*["']USD["']/);
  });

  it("currency-pair-consumer-closure keeps every source-derived event consumer versioned and paired", () => {
    const consumers = sourceDerivedVersionedPairConsumers();
    expect(consumers.length).toBeGreaterThan(0);
    for (const file of consumers) {
      const text = source(file);
      expect(text, `${file} must retain currency beside the amount`).toMatch(/priceCurrencyCode|price_currency_code/);
      expect(text, `${file} must retain the source version beside the pair`).toMatch(
        /streamVersion|stream_version|sourceVersion|source_version|last_stream_version/,
      );
    }
  });

  it("registers every source-derived buy-now price handoff producer", () => {
    const unregistered = sourceDerivedBuyNowPriceProducers().filter((file) => !registeredBuyNowPriceHandoffs.has(file));
    expect(unregistered).toEqual([]);
  });

  it.each([...registeredBuyNowPriceHandoffs.entries()])(
    "keeps the complete Listing price pair in transitive buy-now handoff %s",
    (file, evidence) => {
      const text = source(file);
      for (const fragment of evidence) expect(text).toContain(fragment);
      expect(text).not.toContain('formatMoney(source.priceAmount, "USD")');
    },
  );
});
