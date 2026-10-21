import { describe, expect, it } from "vitest";
import {
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexUsagePreflight,
  providerPagesUpperBound,
} from "./scrydex-option-refresh";

describe("Scrydex bounded option refresh", () => {
  it.each([
    [0, 2],
    [100, 2],
    [101, 3],
    [1000, 11],
  ])("bounds provider pages for %i total", (total, expected) => {
    expect(providerPagesUpperBound(total)).toBe(expected);
  });

  it("rejects over-cap totals", () => {
    expect(providerPagesUpperBound(1001)).toBeNull();
  });

  it.each([
    ["disabled", "unavailable"],
    ["unarmed", "unavailable"],
    ["armed", "usage-readiness:unknown"],
    ["terminal", "usage-readiness:unknown"],
    ["unavailable", "usage-readiness:unknown"],
    ["missing", "usage-readiness:unknown"],
  ])("refuses non-ready usage state %s", (state) => {
    const result = evaluateScrydexUsagePreflight({
      providerKey: "scrydex",
      usageBudget: { readiness: "unknown", freshness: state },
    });
    expect(result.admitted).toBe(false);
  });

  it("admits fresh usage with allowance and balance", () => {
    const result = evaluateScrydexUsagePreflight({
      providerKey: "scrydex",
      providerReadiness: "ready",
      usageBudget: {
        readiness: "ready",
        freshness: "fresh",
        creditAllowance: 5000,
        creditBalance: 4000,
        observedAt: "2026-10-21T00:00:00.000Z",
      },
    });
    expect(result.admitted).toBe(true);
  });

  it("admits one typed forced sets request and rejects cache or cursor variants", () => {
    const base =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p&profileVersion=v&ingestionUnitKey=scrydex:one-piece:set:reference-data&queryKind=sets&limit=100&forceRefresh=true";
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: base }).allowed).toBe(true);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${base}&cursor=offset:1` }).allowed).toBe(false);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${base}&cacheOnly=true` }).allowed).toBe(false);
    expect(classifyScrydexOptionRefreshRequest({ method: "POST", url: base }).allowed).toBe(false);
  });
});
