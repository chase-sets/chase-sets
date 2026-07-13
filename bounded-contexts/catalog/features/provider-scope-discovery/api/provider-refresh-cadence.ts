// Config-driven scheduling policy per provider. Free/open providers
// refresh themselves on a generous interval; credit-metered or fragile
// providers stay manual-only until an operator explicitly opts them in, so
// the scheduler structurally cannot burn provider credits or trip fragile
// transports on its own. This is deliberately plain config, not a database
// record: it is a code-reviewed policy decision, not operator state (pause
// state, which IS operator state, lives in the refresh-schedule store).
export type ProviderRefreshCadenceConfig = Readonly<{
  providerKey: string;
  /** Whether the scheduler is allowed to enqueue this provider at all. */
  scheduleEnabled: boolean;
  /**
   * True for providers that must only ever run from an explicit operator
   * action (credit-metered APIs, fragile/cookie-authenticated transports).
   * The scheduler skips these unconditionally, regardless of scheduleEnabled.
   */
  manualOnly: boolean;
  /** True for providers with a metered credit budget shared across imports. */
  creditAware: boolean;
  /** Minimum spacing between scheduled scans for this provider. */
  intervalMs: number;
  /** Human-readable rationale shown on the providers admin surface. */
  reason: string;
}>;

const HOUR_MS = 60 * 60 * 1000;

export const PROVIDER_REFRESH_CADENCE_CONFIG: readonly ProviderRefreshCadenceConfig[] = [
  {
    providerKey: "tcgdex",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 6 * HOUR_MS,
    reason: "Free, unauthenticated API with generous rate limits.",
  },
  {
    providerKey: "mtgjson",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 24 * HOUR_MS,
    reason: "Free bulk-file API; publishes at most a few times a day.",
  },
  {
    providerKey: "lorcanajson",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 24 * HOUR_MS,
    reason: "Free community-maintained data set.",
  },
  {
    providerKey: "lorcast",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 12 * HOUR_MS,
    reason: "Free, unauthenticated API.",
  },
  {
    providerKey: "scryfall",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 24 * HOUR_MS,
    reason: "Free API with a documented fair-use rate limit.",
  },
  {
    providerKey: "ygoprodeck",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 24 * HOUR_MS,
    reason: "Free, unauthenticated API.",
  },
  {
    providerKey: "ygojson",
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 24 * HOUR_MS,
    reason: "Free bulk-file data set.",
  },
  {
    providerKey: "scrydex",
    scheduleEnabled: false,
    manualOnly: true,
    creditAware: true,
    intervalMs: 7 * 24 * HOUR_MS,
    reason:
      "Metered credit budget shared across every Scrydex ingestion unit; stays manual-only until credit-aware scheduling ships.",
  },
  {
    providerKey: "tcgplayer",
    scheduleEnabled: false,
    manualOnly: true,
    creditAware: false,
    intervalMs: 7 * 24 * HOUR_MS,
    reason: "Cookie-authenticated automation transport; scheduling risk is operational fragility, not credit spend.",
  },
];

const DEFAULT_CADENCE = (providerKey: string): ProviderRefreshCadenceConfig => ({
  providerKey,
  scheduleEnabled: false,
  manualOnly: true,
  creditAware: false,
  intervalMs: 7 * 24 * HOUR_MS,
  reason: "No scheduling policy is configured for this provider yet; it defaults to manual-only.",
});

export function getProviderRefreshCadence(
  providerKey: string,
  config: readonly ProviderRefreshCadenceConfig[] = PROVIDER_REFRESH_CADENCE_CONFIG,
): ProviderRefreshCadenceConfig {
  return config.find((entry) => entry.providerKey === providerKey) ?? DEFAULT_CADENCE(providerKey);
}
