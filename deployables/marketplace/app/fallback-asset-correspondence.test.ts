import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { scenarioSeedFallbackAssetPaths } from "@chase-sets/catalog-seed";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/vite", () => ({ reactRouter: () => [] }));
vi.mock("@tailwindcss/vite", () => ({ default: () => [] }));

/**
 * Static correspondence coverage for #5879. `contracts/catalog-seed` exports
 * the full `/fake-cdn/assets/` fallback-path list the scenario seed
 * references; this deployable owns `public/` and is the only place that can
 * verify each path actually resolves to a file, without the seed context
 * reaching across the boundary into deployable structure.
 *
 * The resolution rule below is the same one Vite applies at runtime: static
 * asset paths are served verbatim from `<root>/public` unless `publicDir` is
 * overridden. Reading the real `../vite.config` (rather than assuming the
 * default) means this guard breaks the moment marketplace ever points
 * `publicDir` somewhere else, instead of silently checking the wrong folder.
 */
describe("marketplace fake-cdn fallback asset correspondence (#5879)", () => {
  async function resolvePublicAssetPath(urlPath: string): Promise<string> {
    const { default: viteConfig } = await import("../vite.config");
    const publicDir = viteConfig.publicDir ?? "public";
    const publicRoot = resolve(__dirname, "..", String(publicDir));
    return join(publicRoot, urlPath.replace(/^\//, ""));
  }

  it("resolves every scenario-seed fallback path to a file under public/", async () => {
    expect(scenarioSeedFallbackAssetPaths.length).toBeGreaterThan(0);

    for (const fallbackPath of scenarioSeedFallbackAssetPaths) {
      const resolved = await resolvePublicAssetPath(fallbackPath);
      expect(existsSync(resolved), `${fallbackPath} -> ${resolved}`).toBe(true);
    }
  });

  it("rejects a synthetic missing fallback while the real assets still resolve (negative control)", async () => {
    // A fixture-only filename that can never collide with a real production
    // asset (unlike a real card name, which could legitimately be added to
    // public/fake-cdn/assets/ later and silently turn this into a false
    // failure). Proves the resolver above rejects an absent file rather than
    // passing vacuously, without depending on any path staying absent forever.
    const syntheticMissingFallback = "/fake-cdn/assets/__fallback-asset-correspondence-test-missing-control__.png";
    expect(scenarioSeedFallbackAssetPaths).not.toContain(syntheticMissingFallback);
    const resolvedMissing = await resolvePublicAssetPath(syntheticMissingFallback);
    expect(existsSync(resolvedMissing)).toBe(false);

    for (const fallbackPath of scenarioSeedFallbackAssetPaths) {
      const resolved = await resolvePublicAssetPath(fallbackPath);
      expect(existsSync(resolved)).toBe(true);
    }
  });
});
