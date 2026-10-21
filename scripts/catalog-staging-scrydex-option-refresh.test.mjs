import { describe, expect, it } from "vitest";
import {
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexUsagePreflight,
  providerPagesUpperBound,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/scrydex-option-refresh.ts";

describe("hosted Scrydex option refresh contract", () => {
  it("uses the bounded page arithmetic", () => {
    expect([0, 100, 101].map(providerPagesUpperBound)).toEqual([2, 2, 3]);
    expect(providerPagesUpperBound(1001)).toBeNull();
  });

  it("refuses usage until the provider is fresh, ready and funded", () => {
    expect(
      evaluateScrydexUsagePreflight({
        providerKey: "scrydex",
        usageBudget: { readiness: "ready", freshness: "stale", creditBalance: 5000, creditAllowance: 5000 },
      }),
    ).toMatchObject({ admitted: false, reason: "usage-stale:stale" });
    expect(
      evaluateScrydexUsagePreflight({
        providerKey: "scrydex",
        usageBudget: { readiness: "ready", freshness: "fresh", creditBalance: 5000, creditAllowance: 5000 },
      }),
    ).toMatchObject({ admitted: true });
  });

  it("fences cursor, cache-only and non-Scrydex requests", () => {
    const href =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p&profileVersion=v&ingestionUnitKey=scrydex:one-piece:set:reference-data&queryKind=sets&limit=100&forceRefresh=true";
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: href }).allowed).toBe(true);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${href}&cursor=offset:1` }).allowed).toBe(false);
    expect(
      classifyScrydexOptionRefreshRequest({
        method: "GET",
        url: href.replace("providerKey=scrydex", "providerKey=tcgdex"),
      }).allowed,
    ).toBe(false);
  });
});
