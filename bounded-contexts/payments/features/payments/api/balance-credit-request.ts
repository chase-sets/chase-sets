export function normalizeRequestedBalanceCreditAmount(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
