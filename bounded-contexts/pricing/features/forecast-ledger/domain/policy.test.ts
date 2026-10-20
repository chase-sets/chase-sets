import { describe, expect, it } from "vitest";
import { decodeForecastLedgerPolicyValue, FORECAST_LEDGER_LAUNCH_POLICY_VALUE, forecastLedgerPolicy } from "./policy";

describe("pricing.forecast-ledger policy", () => {
  it("defaults to the app's horizons and grace with the curve forecast adopted at 21 days", () => {
    expect(forecastLedgerPolicy.policyKey).toBe("pricing.forecast-ledger");
    expect(decodeForecastLedgerPolicyValue({})).toEqual(FORECAST_LEDGER_LAUNCH_POLICY_VALUE);
    expect(FORECAST_LEDGER_LAUNCH_POLICY_VALUE).toEqual({
      horizonsDays: [14, 21, 28],
      graceDays: 2,
      adoptedForecastKind: "curve",
      adoptionHorizonDays: 21,
      gradeDisclosureMinimumCount: 30,
    });
    expect(
      decodeForecastLedgerPolicyValue({
        horizonsDays: [7, 30],
        adoptionHorizonDays: 30,
        adoptedForecastKind: "buyer-choice",
      }),
    ).toEqual({
      horizonsDays: [7, 30],
      graceDays: 2,
      adoptedForecastKind: "buyer-choice",
      adoptionHorizonDays: 30,
      gradeDisclosureMinimumCount: 30,
    });
  });

  it.each([
    [[], /must be an object/],
    [{ horizonDays: [14] }, /Unknown forecast-ledger policy key/],
    [{ horizonsDays: [] }, /ascending distinct/],
    [{ horizonsDays: [21, 14] }, /ascending distinct/],
    [{ horizonsDays: [14, 14] }, /ascending distinct/],
    [{ horizonsDays: [14, 91] }, /ascending distinct/],
    [{ horizonsDays: [1.5] }, /ascending distinct/],
    [{ graceDays: 14 }, /below the shortest horizon/],
    [{ graceDays: -1 }, /below the shortest horizon/],
    [{ adoptedForecastKind: "Curve" }, /name a Forecast Kind/],
    [{ adoptionHorizonDays: 30 }, /one of horizonsDays/],
    [{ gradeDisclosureMinimumCount: 0 }, /gradeDisclosureMinimumCount/],
    [{ gradeDisclosureMinimumCount: 1.5 }, /gradeDisclosureMinimumCount/],
    [{ gradeDisclosureMinimumCount: null }, /gradeDisclosureMinimumCount/],
  ])("rejects %j", (raw, message) => {
    expect(() => decodeForecastLedgerPolicyValue(raw as never)).toThrow(message);
  });

  it("accepts the additive disclosure key and defaults old revisions to 30", () => {
    expect(decodeForecastLedgerPolicyValue({ graceDays: 1 }).gradeDisclosureMinimumCount).toBe(30);
    expect(decodeForecastLedgerPolicyValue({ gradeDisclosureMinimumCount: 40 }).gradeDisclosureMinimumCount).toBe(40);
    expect(forecastLedgerPolicy.schemaSummary).toContain("gradeDisclosureMinimumCount");
  });
});
