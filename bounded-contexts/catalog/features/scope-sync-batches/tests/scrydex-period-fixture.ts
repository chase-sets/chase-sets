import { z } from "zod";
import * as period from "../domain/scrydex-billing-period";
import { guardDisabledMutant } from "./count-capture-mutants";

export const periodAt = "2026-10-13T08:02:00.000Z";
export const syntheticPeriod = {
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2027-01-01T00:00:00.000Z",
  overageCreditsConsumed: 0,
};
export const periodReserve = (runId = "synthetic-dispatch", credits: number | null = 0) => ({
  runId,
  startsAt: syntheticPeriod.startsAt,
  endsAt: syntheticPeriod.endsAt,
  observedAt: periodAt,
  credits,
});
export function periodGateForTest() {
  if (process.env.SCRYDEX_PERIOD_MUTANT !== "bypass-period-cap") return period.evaluateScrydexBillingPeriod;
  return guardDisabledMutant<typeof period.evaluateScrydexBillingPeriod>(
    "../domain/scrydex-billing-period.ts",
    [
      "consumed + unreflected + plannedCredits <= scrydexPeriodCap",
      "consumed + unreflected + plannedCredits <= Number.MAX_SAFE_INTEGER",
    ],
    "evaluateScrydexBillingPeriod",
    { z },
  );
}
