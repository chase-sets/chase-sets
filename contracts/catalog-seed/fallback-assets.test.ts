import { describe, expect, it } from "vitest";
import { scenarioSeedFallbackAssetPaths, scenarioSeedFallbackAssets } from "./fallback-assets";

describe("scenario seed fallback asset paths", () => {
  it("lists every fallback path under /fake-cdn/assets/ exactly once", () => {
    for (const path of scenarioSeedFallbackAssetPaths) {
      expect(path).toMatch(/^\/fake-cdn\/assets\/[\w.-]+$/);
    }
    expect(new Set(scenarioSeedFallbackAssetPaths).size).toBe(scenarioSeedFallbackAssetPaths.length);
  });

  it("keeps the named export and the path list in sync", () => {
    expect(scenarioSeedFallbackAssetPaths).toEqual(Object.values(scenarioSeedFallbackAssets));
  });
});
