import { describe, expect, it, vi } from "vitest";
import { captureScrydexUsageTestModeFixture, replayScrydexUsageTestModeFixture } from "./usage-test-mode-probe";
import {
  evaluateScrydexUsageLaunchGate,
  parseScrydexUsageTestModeFixture,
  type ScrydexUsageTestModeFixture,
} from "./usage-test-mode-fixture";

// Synthetic credentials and usage values only; no provider is contacted. The usage
// body follows the real Scrydex `data` envelope captured by the host on 2026-10-09.
const syntheticEnv = {
  SCRYDEX_API_KEY: "synthetic-scrydex-api-key-8427",
  SCRYDEX_TEAM_ID: "synthetic-scrydex-team-8427",
};
const observedAt = new Date("2026-10-09T12:00:00.000Z");
const minutes = (count: number) => new Date(observedAt.getTime() + count * 60_000);

function syntheticFixture(overrides: Partial<ScrydexUsageTestModeFixture> = {}): ScrydexUsageTestModeFixture {
  return {
    schemaVersion: "scrydex-usage-test-mode-fixture-v1",
    providerKey: "scrydex",
    observedAt: observedAt.toISOString(),
    attemptState: "checked",
    lagCategory: "documented-window",
    providerUpdatedAt: null,
    creditUnit: "credits",
    creditState: "available",
    totalCredits: 50_000,
    remainingCredits: 41_234,
    usedCredits: 8_766,
    diagnosticCode: null,
    operatorConfirmation: "required",
    importAuthorization: "none",
    ...overrides,
  };
}

describe("Scrydex usage test-mode fixture", () => {
  it("captures one usage read through the adapter into the closed redacted schema", async () => {
    const fetch = vi.fn(async (request: Parameters<typeof globalThis.fetch>[0]) => {
      expect(new URL(String(request)).pathname).toBe("/account/v1/usage");
      return Response.json({
        data: {
          total_credits_consumed: 8_766,
          overage_credits_consumed: 0,
          credits_remaining: 41_234,
          period_start: "2026-09-22T19:39:46.000Z",
          period_end: "2026-10-22T19:39:46.000Z",
          daily_usage: [{ date: "2026-10-01", credits_consumed: 8_766 }],
          account_id: "synthetic-account-8427",
        },
        invoice_url: "https://synthetic-billing.invalid/invoices/synthetic",
      });
    });

    const fixture = await captureScrydexUsageTestModeFixture({ env: syntheticEnv, fetch, now: () => observedAt });

    expect(fixture).toStrictEqual(syntheticFixture());
    expect(fetch).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(fixture);
    for (const forbidden of [
      ...Object.values(syntheticEnv),
      "synthetic-account-8427",
      "synthetic-billing.invalid",
      "2026-09-22",
      "2026-10-01",
      "daily_usage",
      "https://",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("refuses to capture without named credential variables and sends nothing", async () => {
    const fetch = vi.fn();

    await expect(captureScrydexUsageTestModeFixture({ env: {}, fetch })).rejects.toThrow(
      "Set SCRYDEX_API_KEY and SCRYDEX_TEAM_ID",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays a host in-cluster capture through the adapter at its observed instant without a request", async () => {
    const networkFetch = vi.spyOn(globalThis, "fetch");
    const body = {
      data: {
        total_credits_consumed: 8_766,
        overage_credits_consumed: 0,
        credits_remaining: 41_234,
        period_start: "2026-09-22T19:39:46.000Z",
        period_end: "2026-10-22T19:39:46.000Z",
        daily_usage: [{ date: "2026-10-01", credits_consumed: 8_766 }],
      },
    };

    try {
      expect(
        await replayScrydexUsageTestModeFixture({ observedAt: observedAt.toISOString(), httpStatus: 200, body }),
      ).toStrictEqual(syntheticFixture());
      const overage = await replayScrydexUsageTestModeFixture({
        observedAt: observedAt.toISOString(),
        httpStatus: 200,
        body: { data: { ...body.data, overage_credits_consumed: 5, credits_remaining: 0 } },
      });
      expect(overage).toMatchObject({ creditState: "exhausted", totalCredits: null, remainingCredits: 0 });
      expect(evaluateScrydexUsageLaunchGate(overage, observedAt).reasons).toEqual([
        "allowance-unreported",
        "credits-exhausted",
      ]);
      expect(networkFetch).not.toHaveBeenCalled();
    } finally {
      networkFetch.mockRestore();
    }
  });

  it.each([
    ["an extra raw provider field", { ...syntheticFixture(), accountId: "synthetic-account-8427" }],
    ["a missing lag category", (({ lagCategory: _omitted, ...rest }) => rest)(syntheticFixture())],
    ["a URL diagnostic", syntheticFixture({ diagnosticCode: "https://synthetic-scrydex.invalid/x" })],
    ["a non-ISO observed-at", { ...syntheticFixture(), observedAt: "2026-10-09 12:00" }],
    ["a string balance", { ...syntheticFixture(), remainingCredits: "41234" }],
    ["an import authorization", { ...syntheticFixture(), importAuthorization: "authorized" }],
  ])("rejects a fixture with %s", (_label, value) => {
    expect(() => parseScrydexUsageTestModeFixture(value)).toThrow(/Scrydex usage fixture/);
  });

  it("requires operator confirmation for a fresh reported allowance and never authorizes an import", () => {
    expect(evaluateScrydexUsageLaunchGate(syntheticFixture(), minutes(15))).toEqual({
      decision: "operator-confirmation-required",
      reasons: [],
      importAuthorization: "none",
    });
  });

  it.each([
    ["stale usage", syntheticFixture(), minutes(16), ["usage-stale"]],
    ["a null allowance", syntheticFixture({ totalCredits: null }), minutes(0), ["allowance-unreported"]],
    [
      "a null balance",
      syntheticFixture({ remainingCredits: null, creditState: "unknown" }),
      minutes(0),
      ["balance-unreported"],
    ],
    [
      "an unchecked read",
      syntheticFixture({ attemptState: "unavailable", observedAt: null, totalCredits: null, remainingCredits: null }),
      minutes(0),
      ["usage-not-checked", "allowance-unreported", "balance-unreported"],
    ],
    [
      "exhausted credits",
      syntheticFixture({ remainingCredits: 0, creditState: "exhausted" }),
      minutes(0),
      ["credits-exhausted"],
    ],
  ] as const)("refuses the launch gate for %s", (_label, fixture, now, reasons) => {
    expect(evaluateScrydexUsageLaunchGate(fixture, now)).toEqual({
      decision: "refused",
      reasons,
      importAuthorization: "none",
    });
  });
});
