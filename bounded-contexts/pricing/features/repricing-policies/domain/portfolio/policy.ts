/**
 * The portfolio solvers' values, ported from the parity app
 * (tcgplayer-automation-app at bdeffa01). They are compiled into every
 * portfolio Goal Version and hashed into each plan's identity: a changed value
 * changes plans, so it ships as a new Goal Version, never as a runtime override.
 */
export const PORTFOLIO_SOLVER_POLICY = {
  /** Log-spaced horizons a plan samples before bisecting (the app's `VALUE_MATCH_SAMPLE_COUNT`). */
  horizonSampleCount: 24,
  /** Bisection steps between two samples that straddle the target (`VALUE_MATCH_REFINEMENTS`). */
  bisectionSteps: 16,
  /** Log-spaced horizons the best-cycle search scores (`BEST_CYCLE_GRID_COUNT`). */
  bestCycleSampleCount: 128,
  /** Horizons sampled to fit the Horizon Value Curve (`HORIZON_FIT_SAMPLE_COUNT`). */
  horizonFitSampleCount: 24,
  /** A value within this many basis points of its target matches it, but never closer than one cent. */
  valueToleranceBps: 1,
  minimumValueToleranceCents: 1,
  /** The shortest horizon a plan searches, in days. */
  minimumHorizonDays: 0.1,
  /** The horizons a plan searches when no listing has an observed sell time. */
  unobservedHorizonRange: { minimumDays: 1, maximumDays: 365 },
  /** A modeled decision read back at fewer qualifying sales than this is sparse. */
  sparseQualifyingSaleCount: 3,
  /** Listings read per keyset page when a portfolio is assembled. */
  pageSize: 500,
  /** Daily Return Hurdles a hurdle sweep evaluates when the caller names none (`INVENTORY_STRATEGY_HURDLES`). */
  sweepDailyReturnHurdles: [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02],
} as const;
