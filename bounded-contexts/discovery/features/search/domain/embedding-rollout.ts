export const DISCOVERY_SEARCH_EMBEDDINGS_CONTROL_ID = "discovery-search-embeddings-disabled";
export const DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR = "DISCOVERY_SEARCH_EMBEDDINGS";
export const DISCOVERY_SEARCH_RESCUE_CONTROL_ID = "discovery-search-rescue-disabled";
export const DISCOVERY_SEARCH_RESCUE_ENV_VAR = "DISCOVERY_SEARCH_RESCUE";
export const DISCOVERY_SEARCH_HYBRID_CONTROL_ID = "discovery-search-hybrid-disabled";
export const DISCOVERY_SEARCH_HYBRID_ENV_VAR = "DISCOVERY_SEARCH_HYBRID";

const DISABLED_VALUES: ReadonlySet<string> = new Set(["disabled", "off", "false", "0", "kill"]);
const ENABLED_VALUES: ReadonlySet<string> = new Set(["enabled", "on", "true", "1", "open"]);

/** Defaults open; a missing provider key still disables the live enrichment runtime. */
export function discoverySearchEmbeddingEnrichmentEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR];
  return raw === undefined || !DISABLED_VALUES.has(raw.trim().toLocaleLowerCase("en-US"));
}

/** Stage 1 ships open, but remains independently kill-switchable. */
export function discoverySearchRescueEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env[DISCOVERY_SEARCH_RESCUE_ENV_VAR];
  return raw === undefined || !DISABLED_VALUES.has(raw.trim().toLocaleLowerCase("en-US"));
}

/** Stage 2 is an explicit rollout and stays off when not configured. */
export function discoverySearchHybridEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env[DISCOVERY_SEARCH_HYBRID_ENV_VAR];
  return raw !== undefined && ENABLED_VALUES.has(raw.trim().toLocaleLowerCase("en-US"));
}
