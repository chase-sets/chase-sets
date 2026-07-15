// Rollout kill-switch for alias contribution to Discovery search, mirroring the
// Catalog Integration Rollout Controls style: an env/config value evaluated at
// runtime (projection refresh and rebuild time), never a deploy-time constant.
// A bad resolved-alias batch is disabled by setting the env value and rebuilding
// the search index; alias text is then dropped from every item's search_text
// without a code deploy. The control defaults to OPEN (aliases enabled) so the
// feature is live unless Ops explicitly disables it.

export const DISCOVERY_ALIAS_SEARCH_CONTROL_ID = "discovery-alias-search-disabled";
export const DISCOVERY_ALIAS_SEARCH_ENV_VAR = "DISCOVERY_ALIAS_SEARCH";

const DISABLED_VALUES: ReadonlySet<string> = new Set(["disabled", "off", "false", "0", "kill"]);

/**
 * Returns whether resolved aliases may contribute to search text. Open by
 * default; closed only when `DISCOVERY_ALIAS_SEARCH` is set to a disabling value.
 */
export function aliasSearchContributionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[DISCOVERY_ALIAS_SEARCH_ENV_VAR];
  if (raw === undefined) {
    return true;
  }

  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}
