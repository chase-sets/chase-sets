import { describe, expect, it } from "vitest";
import * as rollout from "./embedding-rollout";
import {
  DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR,
  DISCOVERY_SEARCH_RESCUE_ENV_VAR,
  discoverySearchEmbeddingEnrichmentEnabled,
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

  it("hybrid config removed", () => {
    expect(Object.keys(rollout)).toEqual(expect.not.arrayContaining([expect.stringMatching(/hybrid/i)]));
  });
});
