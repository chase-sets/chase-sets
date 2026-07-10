export const DISCOVERY_SEARCH_EMBEDDINGS_CONTROL_ID = "discovery-search-embeddings-disabled";
export const DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR = "DISCOVERY_SEARCH_EMBEDDINGS";

const DISABLED_VALUES: ReadonlySet<string> = new Set(["disabled", "off", "false", "0", "kill"]);

/** Defaults open; a missing provider key still disables the live enrichment runtime. */
export function discoverySearchEmbeddingEnrichmentEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR];
  return raw === undefined || !DISABLED_VALUES.has(raw.trim().toLocaleLowerCase("en-US"));
}
