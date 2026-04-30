export function normalizeRequestedBalanceCreditAmount(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const amount = String(value).trim();
  return amount.length === 0 ? null : amount;
}
