export const DISCOVERY_SEARCH_EMBEDDINGS_CONTROL_ID = "discovery-search-embeddings-disabled";
export const DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR = "DISCOVERY_SEARCH_EMBEDDINGS";
export const DISCOVERY_SEARCH_RESCUE_CONTROL_ID = "discovery-search-rescue-disabled";
export const DISCOVERY_SEARCH_RESCUE_ENV_VAR = "DISCOVERY_SEARCH_RESCUE";

const DISABLED_VALUES: ReadonlySet<string> = new Set(["disabled", "off", "false", "0", "kill"]);

/** Defaults open; a missing provider key still disables the live enrichment runtime. */
export function discoverySearchEmbeddingEnrichmentEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR];
  return raw === undefined || !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** Rescue defaults open, but remains independently kill-switchable. */
export function discoverySearchRescueEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env[DISCOVERY_SEARCH_RESCUE_ENV_VAR];
  return raw === undefined || !DISABLED_VALUES.has(raw.trim().toLowerCase());
}
