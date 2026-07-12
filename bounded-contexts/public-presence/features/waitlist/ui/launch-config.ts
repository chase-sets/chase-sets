/**
 * Canonical launch-timeline values for public landing copy.
 *
 * September 1, 2026 is the only hard public date. Beta invite waves are
 * gated on ops metrics between waves, so the public window deliberately
 * stays at season resolution ("late July") and never promises per-wave
 * dates.
 *
 * Copy interpolates these values via {publicLaunchDate} / {betaWavesWindow}
 * tokens in `contracts/localization/locales/en/public-presence.ts`, so a
 * date change is a one-line edit here.
 */
export const launchTimeline = {
  /** Public launch: open signup for everyone. */
  publicLaunchDate: "September 1, 2026",
  /** When numbered beta invite waves begin — never a per-wave date promise. */
  betaWavesWindow: "late July 2026",
} as const;
