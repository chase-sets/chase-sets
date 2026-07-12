import type { WaitlistGame } from "../domain/common";
import { WAITLIST_GAMES } from "../domain/common";

/**
 * Wave-1 campaign admission bar: the pre-declared pass/fail threshold that
 * turns "did the campaign work" into a measurement instead of a vibe.
 * Recorded here BEFORE campaign day 1, and cross-posted to the wave-exposure
 * configuration work item so the numbers live in both the code that
 * evaluates them and the process that gates cohort admission.
 *
 * A "qualified seller" is a sell/both-intent waitlist signup that named at
 * least one game and gave a real (non-empty) inventory-size bucket -- signup
 * intent alone is not evidence of real inventory.
 *
 * These are initial, deliberately round numbers for the first campaign wave.
 * Tighten or loosen them here (not by touching call sites) once actual
 * campaign data suggests better ones; each field documents the reasoning it
 * was set with.
 */
export const WAVE_ONE_ADMISSION_BAR = Object.freeze({
  /**
   * Total qualified sellers (see definition above) required before wave 1 is
   * considered to have real supply behind it. Matches the issue's own
   * example bar ("&gt;=50 sellers with real inventory").
   */
  minQualifiedSellers: 50,
  /**
   * Minimum qualified sellers per game required for every one of the five
   * supported games to count as "covered" -- a cohort of 50 sellers who all
   * only sell Pokemon does not span all five games, even though it clears
   * `minQualifiedSellers`. Deliberately low (not an even 50/5 split): early
   * cohorts are expected to skew toward whichever game the campaign's
   * content performs best with, and the bar only needs proof that no game is
   * a total blind spot, not proportional coverage.
   */
  minQualifiedSellersPerGame: 5,
  /**
   * Overall signup floor across every role (buy, sell, both) -- the
   * "audience exists at all" half of the bar, independent of seller supply
   * quality. Round number chosen as a floor well above the waitlist
   * counter's own display-suppression bucket (25, see
   * WAITLIST_COUNTER_DISPLAY_BUCKET in domain/common.ts) so clearing the bar
   * always means clearing public social-proof visibility too.
   */
  minTotalSignups: 500,
});

export type WaveOneGameCoverage = Readonly<{
  game: WaitlistGame;
  qualifiedSellerCount: number;
  covered: boolean;
}>;

export type WaveOneAdmissionBarStatus = Readonly<{
  totalSignups: number;
  qualifiedSellerCount: number;
  totalSignupsMet: boolean;
  qualifiedSellersMet: boolean;
  gameCoverage: readonly WaveOneGameCoverage[];
  allGamesCovered: boolean;
  /** True only when every sub-condition above is true. */
  admitted: boolean;
}>;

/**
 * Pure evaluator -- no I/O -- so the bar's pass/fail logic is unit-testable
 * against {@link WAVE_ONE_ADMISSION_BAR} without a database.
 */
export function evaluateWaveOneAdmissionBar(
  input: Readonly<{
    totalSignups: number;
    qualifiedSellerCount: number;
    qualifiedSellersByGame: Readonly<Partial<Record<WaitlistGame, number>>>;
  }>,
): WaveOneAdmissionBarStatus {
  const gameCoverage: WaveOneGameCoverage[] = WAITLIST_GAMES.map((game) => {
    const qualifiedSellerCount = input.qualifiedSellersByGame[game] ?? 0;
    return {
      game,
      qualifiedSellerCount,
      covered: qualifiedSellerCount >= WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
    };
  });
  const allGamesCovered = gameCoverage.every((entry) => entry.covered);
  const totalSignupsMet = input.totalSignups >= WAVE_ONE_ADMISSION_BAR.minTotalSignups;
  const qualifiedSellersMet = input.qualifiedSellerCount >= WAVE_ONE_ADMISSION_BAR.minQualifiedSellers;

  return {
    totalSignups: input.totalSignups,
    qualifiedSellerCount: input.qualifiedSellerCount,
    totalSignupsMet,
    qualifiedSellersMet,
    gameCoverage,
    allGamesCovered,
    admitted: totalSignupsMet && qualifiedSellersMet && allGamesCovered,
  };
}
