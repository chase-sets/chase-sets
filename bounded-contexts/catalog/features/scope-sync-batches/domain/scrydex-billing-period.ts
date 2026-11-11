import { z } from "zod";

const credits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
export const scrydexBillingPeriodSchema = z.object({
  startsAt: instant,
  endsAt: instant,
  overageCreditsConsumed: credits,
}).strict();
export const scrydexPeriodReserveSchema = z.object({
  runId: z.string().min(1).max(200),
  startsAt: instant,
  endsAt: instant,
  observedAt: instant,
  // Cross-path dispatch-log total, including concurrent and uncertain sends.
  // Count's own durable commitments are reconciled separately, never here.
  credits: credits.nullable(),
}).strict();
export type ScrydexBillingPeriod = z.infer<typeof scrydexBillingPeriodSchema>;
export const scrydexPeriodCap = 50_000;
export const scrydexPeriodDecisionSchema = z.object({
  admitted: z.boolean(),
  reason: z.literal("usage-period-cap").nullable(),
  runId: z.string(),
  observedAt: instant.nullable(),
  period: scrydexBillingPeriodSchema.nullable(),
  consumedCredits: credits.nullable(),
  unreflectedCredits: credits.nullable(),
  plannedCredits: credits,
}).strict();
export type ScrydexPeriodDecision = z.infer<typeof scrydexPeriodDecisionSchema>;

export function evaluateScrydexBillingPeriod(input: {
  snapshot: { allowance: unknown; balance: unknown; observedAt: unknown; period: unknown };
  reserve: unknown;
  durableCredits: number | null;
  plannedCredits: number;
  runId: string;
  now: string;
}): ScrydexPeriodDecision {
  const { snapshot, runId, plannedCredits } = input;
  const period = scrydexBillingPeriodSchema.safeParse(snapshot.period);
  const reserve = scrydexPeriodReserveSchema.safeParse(input.reserve);
  const fresh = (value: unknown): value is string => {
    if (!instant.safeParse(value).success || !instant.safeParse(input.now).success) return false;
    const age = Date.parse(input.now) - Date.parse(value as string);
    return age >= 0 && age <= 900_000;
  };
  const validSnapshot = period.success && fresh(snapshot.observedAt) &&
    Date.parse(period.data.startsAt) <= Date.parse(snapshot.observedAt) &&
    Date.parse(period.data.endsAt) > Date.parse(input.now) &&
    period.data.overageCreditsConsumed === 0 &&
    credits.safeParse(snapshot.allowance).success && credits.safeParse(snapshot.balance).success &&
    (snapshot.balance as number) <= (snapshot.allowance as number);
  const consumed = validSnapshot ? (snapshot.allowance as number) - (snapshot.balance as number) : null;
  const validReserve = reserve.success && period.success && reserve.data.runId === runId &&
    reserve.data.startsAt === period.data.startsAt && reserve.data.endsAt === period.data.endsAt &&
    fresh(reserve.data.observedAt) && reserve.data.credits !== null &&
    credits.safeParse(input.durableCredits).success;
  const unreflected = validReserve ? reserve.data.credits! + input.durableCredits! : null;
  const admitted = consumed !== null && unreflected !== null && Number.isSafeInteger(unreflected) &&
    credits.safeParse(plannedCredits).success && consumed + unreflected + plannedCredits <= scrydexPeriodCap;
  return {
    admitted, reason: admitted ? null : "usage-period-cap", runId,
    observedAt: instant.safeParse(snapshot.observedAt).success ? snapshot.observedAt as string : null,
    period: period.success ? period.data : null,
    consumedCredits: consumed,
    unreflectedCredits: unreflected !== null && Number.isSafeInteger(unreflected) ? unreflected : null,
    plannedCredits,
  };
}
