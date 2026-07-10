import { describe, expect, it } from "vitest";
import { DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR, discoverySearchEmbeddingEnrichmentEnabled } from "./embedding-rollout";

describe("Discovery search embedding kill-switch", () => {
  it("defaults open", () => {
    expect(discoverySearchEmbeddingEnrichmentEnabled({})).toBe(true);
  });

  it.each(["disabled", "off", "false", "0", "kill", " OFF "])("closes for %s", (value) => {
    expect(discoverySearchEmbeddingEnrichmentEnabled({ [DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR]: value })).toBe(false);
  });
});
