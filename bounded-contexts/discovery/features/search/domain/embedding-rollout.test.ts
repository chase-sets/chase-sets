import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR,
  DISCOVERY_SEARCH_HYBRID_ENV_VAR,
  DISCOVERY_SEARCH_RESCUE_ENV_VAR,
  discoverySearchEmbeddingEnrichmentEnabled,
  discoverySearchHybridEnabled,
  discoverySearchRescueEnabled,
} from "./embedding-rollout";

describe("Discovery search embedding kill-switch", () => {
  it("defaults open", () => {
    expect(discoverySearchEmbeddingEnrichmentEnabled({})).toBe(true);
  });

  it.each(["disabled", "off", "false", "0", "kill", " OFF "])("closes for %s", (value) => {
    expect(discoverySearchEmbeddingEnrichmentEnabled({ [DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR]: value })).toBe(false);
  });

  it("ships rescue open with its own kill-switch", () => {
    expect(discoverySearchRescueEnabled({})).toBe(true);
    expect(discoverySearchRescueEnabled({ [DISCOVERY_SEARCH_RESCUE_ENV_VAR]: "kill" })).toBe(false);
  });

  it("keeps hybrid closed until explicitly enabled", () => {
    expect(discoverySearchHybridEnabled({})).toBe(false);
    expect(discoverySearchHybridEnabled({ [DISCOVERY_SEARCH_HYBRID_ENV_VAR]: "enabled" })).toBe(true);
    expect(discoverySearchHybridEnabled({ [DISCOVERY_SEARCH_HYBRID_ENV_VAR]: "off" })).toBe(false);
  });
});
