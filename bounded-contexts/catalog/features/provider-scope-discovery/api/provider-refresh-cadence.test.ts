import { describe, expect, it } from "vitest";
import { getProviderRefreshCadence, PROVIDER_REFRESH_CADENCE_CONFIG } from "./provider-refresh-cadence";

// AC (#3796): credit-consuming providers are provably excluded from the
// schedule per config, and unknown providers fail closed to manual-only.
describe("provider refresh cadence config", () => {
  it("keeps Scrydex manual-only, credit-aware, and excluded from scheduling", () => {
    const scrydex = getProviderRefreshCadence("scrydex");

    expect(scrydex.scheduleEnabled).toBe(false);
    expect(scrydex.manualOnly).toBe(true);
    expect(scrydex.creditAware).toBe(true);
  });

  it("keeps the cookie-authenticated TCGplayer transport manual-only", () => {
    const tcgplayer = getProviderRefreshCadence("tcgplayer");

    expect(tcgplayer.scheduleEnabled).toBe(false);
    expect(tcgplayer.manualOnly).toBe(true);
  });

  it("schedules every free provider and never marks one credit-aware", () => {
    const freeProviders = PROVIDER_REFRESH_CADENCE_CONFIG.filter((entry) => !entry.manualOnly);

    expect(freeProviders.map((entry) => entry.providerKey).sort()).toEqual([
      "lorcanajson",
      "lorcast",
      "mtgjson",
      "scryfall",
      "tcgdex",
      "ygojson",
      "ygoprodeck",
    ]);
    for (const entry of freeProviders) {
      expect(entry.scheduleEnabled).toBe(true);
      expect(entry.creditAware).toBe(false);
      expect(entry.intervalMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    }
  });

  it("fails closed to manual-only for providers with no configured policy", () => {
    const unknown = getProviderRefreshCadence("some-future-provider");

    expect(unknown.scheduleEnabled).toBe(false);
    expect(unknown.manualOnly).toBe(true);
  });

  it("declares every configured provider exactly once", () => {
    const keys = PROVIDER_REFRESH_CADENCE_CONFIG.map((entry) => entry.providerKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
