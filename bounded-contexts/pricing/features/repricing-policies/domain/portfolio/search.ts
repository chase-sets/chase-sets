import { PORTFOLIO_SOLVER_POLICY } from "./policy";

/**
 * Horizon searches shared by Pricing Goals and portfolio plans, ported from
 * the parity app (tcgplayer-automation-app at bdeffa01: `horizonValueCurve.ts`,
 * `maximize.ts` and `pricingPolicy.ts`), keeping its operation order.
 */

const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
const REFINEMENT_ITERATIONS = 24;

export type HorizonRange = Readonly<{ minimumDays: number; maximumDays: number }>;

/** One evaluated horizon; `value` is in cents. */
export type HorizonCandidate = Readonly<{ horizonDays: number; value: number }>;

/** Horizons spaced evenly in log space from minimum to maximum, endpoints exact. */
export function logSpacedHorizons(minimumDays: number, maximumDays: number, count: number): number[] {
  const lastIndex = count - 1;
  return Array.from({ length: count }, (_, index) =>
    index === 0
      ? minimumDays
      : index === lastIndex
        ? maximumDays
        : minimumDays * (maximumDays / minimumDays) ** (index / lastIndex),
  );
}

/**
 * Every candidate is scored first so a score with more than one peak cannot
 * trap the search; golden-section search then sharpens between the best
 * candidate's neighbours, keeping the best candidate when refinement cannot
 * beat it.
 */
export function maximizeOverCandidates(
  candidates: readonly number[],
  score: (argument: number) => number,
): Readonly<{ argument: number; value: number }> | undefined {
  const scores = candidates.map(score);
  const bestIndex = scores.indexOf(Math.max(...scores));
  if (bestIndex < 0) return undefined;
  const best = { argument: candidates[bestIndex]!, value: scores[bestIndex]! };
  let low = candidates[Math.max(0, bestIndex - 1)]!;
  let high = candidates[Math.min(candidates.length - 1, bestIndex + 1)]!;
  if (low === high) return best;
  let lower = high - GOLDEN_RATIO * (high - low);
  let upper = low + GOLDEN_RATIO * (high - low);
  let lowerScore = score(lower);
  let upperScore = score(upper);
  for (let iteration = 0; iteration < REFINEMENT_ITERATIONS; iteration += 1) {
    if (lowerScore < upperScore) {
      low = lower;
      lower = upper;
      lowerScore = upperScore;
      upper = low + GOLDEN_RATIO * (high - low);
      upperScore = score(upper);
    } else {
      high = upper;
      upper = lower;
      upperScore = lowerScore;
      lower = high - GOLDEN_RATIO * (high - low);
      lowerScore = score(lower);
    }
  }
  const refined = (low + high) / 2;
  const refinedScore = score(refined);
  return refinedScore > best.value ? { argument: refined, value: refinedScore } : best;
}

const sampleHorizons = (range: HorizonRange) =>
  logSpacedHorizons(range.minimumDays, range.maximumDays, PORTFOLIO_SOLVER_POLICY.horizonSampleCount);

/**
 * The evaluated horizon whose value is closest to the target, as the app's
 * `findClosestHorizon`. Every pair of samples that straddles the target is
 * bisected, not only the first, so a value that is not monotone in the horizon
 * cannot hide a closer match; log spacing keeps each step proportional to the
 * horizon.
 */
export function closestHorizon<Candidate extends HorizonCandidate>(
  range: HorizonRange,
  evaluate: (horizonDays: number) => Candidate,
  target: number,
): Readonly<{ best: Candidate; samples: readonly Candidate[] }> {
  const distance = (candidate: Candidate): number => Math.abs(candidate.value - target);
  const samples = sampleHorizons(range).map(evaluate);
  let best = samples.reduce((closest, candidate) => (distance(candidate) < distance(closest) ? candidate : closest));
  for (let index = 1; best.value !== target && index < samples.length; index += 1) {
    let left = samples[index - 1]!;
    let right = samples[index]!;
    if ((left.value - target) * (right.value - target) >= 0) continue;
    for (let step = 0; step < PORTFOLIO_SOLVER_POLICY.bisectionSteps; step += 1) {
      const middle = evaluate(Math.sqrt(left.horizonDays * right.horizonDays));
      if (distance(middle) < distance(best)) best = middle;
      if ((left.value - target) * (middle.value - target) <= 0) right = middle;
      else left = middle;
    }
  }
  return { best, samples };
}

/**
 * The longest evaluated horizon that meets a condition: the last sample that
 * meets it, bisected against the sample after it. A condition met again at a
 * longer sample always wins over an earlier crossing, so a value that is not
 * monotone in the horizon resolves to its last crossing; null when no sample
 * meets it.
 */
export function longestHorizonMeeting<Candidate extends HorizonCandidate>(
  range: HorizonRange,
  evaluate: (horizonDays: number) => Candidate,
  meets: (candidate: Candidate) => boolean,
): Readonly<{ best: Candidate | null; samples: readonly Candidate[] }> {
  const samples = sampleHorizons(range).map(evaluate);
  let lastIndex = samples.length - 1;
  while (lastIndex >= 0 && !meets(samples[lastIndex]!)) lastIndex -= 1;
  if (lastIndex < 0) return { best: null, samples };
  let best = samples[lastIndex]!;
  let missed = samples[lastIndex + 1];
  for (let step = 0; missed !== undefined && step < PORTFOLIO_SOLVER_POLICY.bisectionSteps; step += 1) {
    const middle = evaluate(Math.sqrt(best.horizonDays * missed.horizonDays));
    if (meets(middle)) best = middle;
    else missed = middle;
  }
  return { best, samples };
}
