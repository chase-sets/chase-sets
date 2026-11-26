import { test } from "@playwright/test";

/**
 * Log a loud, explicit reason when a data-dependent E2E assertion is skipped
 * instead of hard-required.
 *
 * The non-vacuous seed-contract initiative set out to replace silent
 * `if-present` guards (a bare `.catch(() => false)` that swallows a missing
 * surface so a skip is indistinguishable from a pass) with hard contracts. Some admin
 * surfaces, however, depend on data the browser-e2e seed genuinely does not
 * create (an in-queue support request, a failed Google Shopping row, a live
 * Catalog sync's Source Observations, etc.) — hard-requiring those fought the
 * production code's own documented fail-soft behavior rather than catching a
 * regression.
 *
 * This helper is the deliberate middle ground: the assertion stays conditional
 * so an un-seeded surface does not fail the suite, but every skip is announced
 * on stdout AND in the Playwright report annotations, so a gap is loud and
 * traceable — never silently mistaken for a pass. Reserved for surfaces proven
 * (by direct browser-e2e DB inspection) to have no seed backing; genuinely
 * seeded assertions stay hard.
 */
export function logSeedContractGap(reason: string): void {
  const message = `[browser-e2e seed contract gap] ${reason}`;
  console.warn(message);
  test.info().annotations.push({ type: "seed-contract-gap", description: message });
}
