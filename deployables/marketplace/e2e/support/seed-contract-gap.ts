import { test } from "@playwright/test";

/**
 * Log a loud, explicit reason when a data/environment-dependent E2E assertion is
 * skipped instead of hard-required.
 *
 * The non-vacuous seed-contract initiative set out to replace silent
 * `if-present` guards (a bare `.catch(() => false)` that swallows a missing
 * surface so a skip is indistinguishable from a pass) with hard contracts. Some buyer
 * surfaces, however, depend on state the browser-e2e environment cannot produce
 * — most notably a payment-ready checkout session: browser-e2e wires no payment
 * provider, so a checkout session created from the seeded cart stays on the
 * "Secure checkout" readiness surface ("Preparing checkout" / "Checkout needs
 * attention") and never advances the checkout deciders to the payment-ready
 * buyer stepper. Hard-requiring the stepper fought that documented readiness
 * behavior rather than catching a regression.
 *
 * This helper is the deliberate middle ground: the assertion stays conditional
 * so an unreachable surface does not fail the suite, but every skip is announced
 * on stdout AND in the Playwright report annotations, so a gap is loud and
 * traceable — never silently mistaken for a pass. The genuinely-reachable,
 * genuinely-seeded boundary (sign-in, the seeded cart, checkout-session
 * creation, the checkout surface) stays hard.
 */
export function logMarketplaceSeedContractGap(reason: string): void {
  const message = `[browser-e2e seed contract gap] ${reason}`;
  console.warn(message);
  test.info().annotations.push({ type: "seed-contract-gap", description: message });
}
