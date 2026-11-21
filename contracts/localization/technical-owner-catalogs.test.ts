import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { englishTranslations } from "./locales/en";

const catalogs = {
  "contracts/localization/locales/en/localization.ts": {
    "localization.localeName": "English",
    "localization.languageCode.en": "English",
    "localization.languageCode.ja": "Japanese",
    "localization.displayIdentity.title": "{title}",
    "localization.displayIdentity.title.and.subtitle": "{title} — {subtitle}",
  },
  "packages/design-system/src/localization/locales/en.ts": {
    "localization.listingCard.view.details.for": "View details for {identity}",
    "localization.listingCard.save": "Save {identity}",
    "localization.listingCard.saved": "Saved {identity}",
    "localization.listingCard.watching": "Watching {identity}",
    "localization.currency.amountIn": "Amount in {currency}.",
    "localization.currency.decreaseAmount": "Decrease amount",
    "localization.currency.increaseAmount": "Increase amount",
    "localization.currency.usd": "US dollars",
  },
  "infrastructure/platform-runtime/localization/locales/en.ts": {
    "localization.routeAction.unsupportedIntent": "This action is not supported.",
    "localization.routeResource.pending": "This page is still updating. Reload it in a moment.",
    "localization.routeResource.unverified": "The update could not be verified. Reload this page and try again.",
    "localization.routeResource.notFound": "The requested resource was not found.",
  },
  "contracts/localization/test-fixtures/localization/locales/en.ts": {
    "localization.testGreeting": "Hello, {name}.",
  },
  "contracts/seller-attention-queue/localization/locales/en.ts": {
    "channels.attention.reason.credential": "Credentials",
    "channels.attention.reason.seller-setup": "Connection setup",
    "channels.attention.reason.subscription": "Subscription",
    "channels.attention.reason.polling": "Channel polling",
    "channels.attention.reason.drift": "Inventory differences",
    "channels.attention.reason.provider-rate": "Channel rate limit",
    "channels.attention.reason.provider-availability": "Channel availability",
    "channels.attention.reason.sale-follow-up": "Sale follow-up",
  },
} as const;

const repo = new URL("../../", import.meta.url);

// Read the authored sources with the discovery parser, not runtime dependencies on their workspaces.
const { analyzeLocaleCatalogModule } = await vi.importActual<{
  analyzeLocaleCatalogModule(input: { filePath: string; ownerLabel: string; source: string }): {
    entries: [string, string][];
  };
}>("../../scripts/sync-workspace-metadata.mjs");

describe("technical localization catalogs", () => {
  it.each(Object.entries(catalogs))("authors the exact baseline entries in %s", (filePath, expected) => {
    const source = readFileSync(new URL(filePath, repo), "utf8");
    const { entries } = analyzeLocaleCatalogModule({ filePath, ownerLabel: filePath, source });

    expect([...entries].sort()).toEqual(Object.entries(expected).sort());
    expect(englishTranslations).toMatchObject(expected);
  });

  it("leaves only the Channel-specific reason in the legacy Channel catalog", () => {
    const filePath = "contracts/localization/locales/en/channels.ts";
    const source = readFileSync(new URL(filePath, repo), "utf8");
    const { entries } = analyzeLocaleCatalogModule({ filePath, ownerLabel: filePath, source });

    expect(entries.filter(([key]) => key.startsWith("channels.attention.reason."))).toEqual([
      ["channels.attention.reason.connector-liveness", "Connector not responding"],
    ]);
  });
});
