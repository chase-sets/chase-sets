import type { DemandCurvePolicyValue } from "../demand-curve-policy";

export type LadderSale = Readonly<{ condition: string; price: number; soldAt: string }>;
export type ConditionLadder = Readonly<{
  method: "time-controlled-zipf" | "sibling-market-ratio" | "neutral-condition-fallback";
  anchorCondition: string | null;
  multipliers: ReadonlyMap<string, number>;
  conditionValues: ReadonlyMap<string, number>;
}>;

function solve(matrix: number[][], values: number[]): number[] | null {
  const rows = matrix.map((row, i) => [...row, values[i]!]);
  for (let column = 0; column < rows.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row++)
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    if (Math.abs(rows[pivot]![column]!) < 1e-10) return null;
    [rows[pivot], rows[column]] = [rows[column]!, rows[pivot]!];
    const divisor = rows[column]![column]!;
    for (let i = column; i <= rows.length; i++) rows[column]![i] = rows[column]![i]! / divisor;
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      for (let i = column; i <= rows.length; i++) rows[row]![i] = rows[row]![i]! - factor * rows[column]![i]!;
    }
  }
  return rows.map((row) => row.at(-1)!);
}

function connected(sales: readonly (LadderSale & { rank: number; time: number })[]): boolean {
  const ranges = new Map<number, { min: number; max: number }>();
  for (const sale of sales) {
    const current = ranges.get(sale.rank);
    ranges.set(sale.rank, {
      min: Math.min(current?.min ?? sale.time, sale.time),
      max: Math.max(current?.max ?? sale.time, sale.time),
    });
  }
  const ranks = [...ranges.keys()];
  const reached = new Set([ranks[0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const rank of ranks) {
      if (reached.has(rank)) continue;
      const candidate = ranges.get(rank)!;
      if (
        [...reached].some((other) => candidate.min <= ranges.get(other)!.max && ranges.get(other)!.min <= candidate.max)
      ) {
        reached.add(rank);
        changed = true;
      }
    }
  }
  return reached.size === ranks.length;
}

/** A single card-wide ladder, rescaled to the requested condition. Unknown conditions never enter it. */
export function buildConditionLadder(
  input: Readonly<{
    sales: readonly LadderSale[];
    siblingMarketPrices: ReadonlyMap<string, number>;
    targetCondition: string;
    asOf: string;
    policy: DemandCurvePolicyValue;
  }>,
): ConditionLadder {
  const { policy, targetCondition } = input;
  const conditions = policy.conditionOrder;
  const targetRank = conditions.indexOf(targetCondition) + 1;
  if (!targetRank) throw new Error("Unknown target condition cannot be scaled.");
  const asOf = Date.parse(input.asOf);
  const msPerDay = 86_400_000;
  const latest = input.sales
    .flatMap((sale) => {
      const rank = conditions.indexOf(sale.condition) + 1;
      const time = Date.parse(sale.soldAt);
      return rank > 0 &&
        sale.price > 0 &&
        Number.isFinite(time) &&
        time <= asOf &&
        time >= asOf - policy.historyDays * msPerDay
        ? [{ ...sale, rank, time }]
        : [];
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, policy.salesLimit);
  const counts = new Map<number, number>();
  for (const sale of latest) counts.set(sale.rank, (counts.get(sale.rank) ?? 0) + 1);
  const sales = latest.filter((sale) => counts.get(sale.rank)! >= policy.minimumObservationsPerCondition);
  const ranks = new Set(sales.map((sale) => sale.rank));
  const times = sales.map((sale) => sale.time / msPerDay);
  const logged = sales.map((sale) => Math.log(sale.rank));
  const meanTime = times.reduce((sum, value) => sum + value, 0) / (times.length || 1);
  const meanRank = logged.reduce((sum, value) => sum + value, 0) / (logged.length || 1);
  const variance = times.reduce((sum, value) => sum + (value - meanTime) ** 2, 0);
  const covariance = times.reduce((sum, value, i) => sum + (value - meanTime) * (logged[i]! - meanRank), 0);
  const slope = variance > 0 ? covariance / variance : 0;
  const information = logged.reduce(
    (sum, value, i) => sum + (value - meanRank - slope * (times[i]! - meanTime)) ** 2,
    0,
  );

  if (sales.length >= 5 && ranks.size >= 2 && information >= 1e-6 && connected(sales)) {
    const features = sales.map((sale) => [
      1,
      (sale.time - asOf) / (policy.historyDays * msPerDay),
      Math.log(sale.rank),
    ]);
    const logPrices = sales.map((sale) => Math.log(sale.price));
    let weights = sales.map(() => 1);
    let coefficients: number[] | null = null;
    for (let iteration = 0; iteration < 4; iteration++) {
      const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
      const vector = [0, 0, 0];
      for (let row = 0; row < features.length; row++)
        for (let left = 0; left < 3; left++) {
          vector[left] += weights[row]! * features[row]![left]! * logPrices[row]!;
          for (let right = 0; right < 3; right++)
            matrix[left]![right] += weights[row]! * features[row]![left]! * features[row]![right]!;
        }
      coefficients = solve(matrix, vector);
      if (!coefficients) break;
      const residuals = features.map(
        (row, i) => logPrices[i]! - row.reduce((sum, value, column) => sum + value * coefficients![column]!, 0),
      );
      const absolute = residuals.map(Math.abs).sort((a, b) => a - b);
      const scale = (absolute[Math.floor(absolute.length / 2)] || 0.01) * 1.4826;
      weights = residuals.map((residual) => Math.min(1, (1.345 * scale) / Math.max(Math.abs(residual), 1e-10)));
    }
    if (coefficients) {
      const exponent = Math.max(
        policy.zipfExponentBounds.minimum,
        Math.min(policy.zipfExponentBounds.maximum, -coefficients[2]!),
      );
      const values = new Map(conditions.map((condition, i) => [condition, 1 / Math.pow(i + 1, exponent)]));
      return {
        method: "time-controlled-zipf",
        anchorCondition: null,
        conditionValues: values,
        multipliers: new Map(conditions.map((condition, i) => [condition, Math.pow((i + 1) / targetRank, exponent)])),
      };
    }
  }

  const values = new Map<string, number>();
  const anchors = new Map<string, string>();
  let ceiling = Infinity;
  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i]!;
    let amount = input.siblingMarketPrices.get(condition);
    if (!(amount && amount > 0)) {
      const neighbor =
        [...conditions.slice(0, i)]
          .reverse()
          .find((candidate) => (input.siblingMarketPrices.get(candidate) ?? 0) > 0) ??
        conditions.slice(i + 1).find((candidate) => (input.siblingMarketPrices.get(candidate) ?? 0) > 0);
      if (neighbor) {
        amount = input.siblingMarketPrices.get(neighbor);
        anchors.set(condition, neighbor);
      }
    }
    if (!(amount && amount > 0)) break;
    ceiling = Math.min(ceiling, amount);
    values.set(condition, ceiling);
  }
  if (values.size === conditions.length) {
    const best = values.get(conditions[0]!)!;
    for (const condition of conditions)
      values.set(condition, Math.max(values.get(condition)!, best / policy.siblingRatioReachLimit));
    const target = values.get(targetCondition)!;
    return {
      method: "sibling-market-ratio",
      anchorCondition: anchors.get(targetCondition) ?? null,
      conditionValues: values,
      multipliers: new Map(conditions.map((condition) => [condition, target / values.get(condition)!])),
    };
  }
  return {
    method: "neutral-condition-fallback",
    anchorCondition: null,
    conditionValues: new Map(conditions.map((condition) => [condition, 1])),
    multipliers: new Map(conditions.map((condition) => [condition, 1])),
  };
}
