import { roundRational } from "@chase-sets/primitives/money";

export function filterCompetingAskOutliers<Ask>(
  asks: readonly Ask[],
  amountCents: (ask: Ask) => bigint,
  estimateCents: bigint | null,
  hardAskOutlierPriceRatio: number,
): readonly Ask[] {
  if (asks.length < 2) return asks;
  const ordered = asks.map(amountCents).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const midpoint = ordered.length / 2;
  const median =
    ordered.length % 2 === 1
      ? ordered[Math.floor(midpoint)]!
      : roundRational(ordered[midpoint - 1]! + ordered[midpoint]!, 2n, "nearest");
  const core = estimateCents ?? median;
  const ratioHundredths = BigInt(Math.round(hardAskOutlierPriceRatio * 100));
  const lower = roundRational(core * 100n, ratioHundredths, "nearest");
  const upper = roundRational(core * ratioHundredths, 100n, "nearest");
  const filtered = asks.filter((ask) => {
    const amount = amountCents(ask);
    return amount >= lower && amount <= upper;
  });
  return filtered.length > 0 ? filtered : asks;
}
