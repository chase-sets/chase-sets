import type { ProviderConnectionRow } from "../api/contracts";

function timestampMillis(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const millis = Date.parse(value);
  const calendarDay = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(millis) || !Number.isFinite(calendarDay.getTime())) return NaN;
  return calendarDay.toISOString().slice(0, 10) === value.slice(0, 10) ? millis : NaN;
}

export function providerConnectionAge(row: ProviderConnectionRow, evaluatedAt: string) {
  const ageSeconds = (timestampMillis(evaluatedAt) - timestampMillis(row.observedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return { state: "unknown", ageSeconds: null } as const;
  if (!row.freshness) return { state: "ageOnly", ageSeconds } as const;
  const limits = row.freshness;
  const state =
    ageSeconds > limits.unavailableAfterSeconds
      ? "unavailable"
      : ageSeconds > limits.staleAfterSeconds
        ? "stale"
        : ageSeconds > limits.freshWithinSeconds
          ? "aging"
          : "fresh";
  return { state, ageSeconds };
}
