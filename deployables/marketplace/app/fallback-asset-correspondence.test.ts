import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { scenarioSeedFallbackAssetPaths } from "@chase-sets/catalog-seed";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-router/dev/vite", () => ({ reactRouter: () => [] }));
vi.mock("@tailwindcss/vite", () => ({ default: () => [] }));

/**
 * Static correspondence coverage for [#10577 Shrink the cart's 2.9 MB fallback
 * card-back thumbnail](https://github.com/chase-sets/chase-sets/issues/10577).
 * `contracts/catalog-seed` exports
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
describe("marketplace fake-cdn fallback asset correspondence (#10577)", () => {
  const fallbackAssetExpectations = [
    {
      path: "/fake-cdn/assets/pokemon-card-back.png",
      originalWidth: 1495,
      originalHeight: 2072,
    },
    {
      path: "/fake-cdn/assets/pokemon_tcg_back.png",
      originalWidth: 1000,
      originalHeight: 1400,
    },
  ] as const;
  const fallbackByteBudget = 65_536;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function decodeIndexedPng(bytes: Buffer) {
    expect(bytes.subarray(0, 8)).toEqual(pngSignature);
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let idat = Buffer.alloc(0);
    let sawIend = false;

    for (let offset = 8; offset < bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      const value = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === "IHDR") {
        width = value.readUInt32BE(0);
        height = value.readUInt32BE(4);
        bitDepth = value[8];
        colorType = value[9];
      } else if (type === "IDAT") {
        idat = Buffer.concat([idat, value]);
      } else if (type === "IEND") {
        sawIend = true;
      }
      offset += length + 12;
    }

    expect(bitDepth).toBe(8);
    expect(colorType).toBe(3);
    expect(sawIend).toBe(true);
    const scanlines = inflateSync(idat);
    expect(scanlines.byteLength).toBe(height * (width + 1));
    return { width, height, scanlines };
  }

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

  it("keeps both card backs decodable, detailed, aspect-correct, and within the transfer budget", async () => {
    const decodedAssets: Buffer[] = [];

    for (const expected of fallbackAssetExpectations) {
      const resolved = await resolvePublicAssetPath(expected.path);
      const bytes = readFileSync(resolved);
      const decoded = decodeIndexedPng(bytes);
      const { width, height } = decoded;

      expect(bytes.byteLength, expected.path + " must fit the fallback transfer budget").toBeLessThanOrEqual(
        fallbackByteBudget,
      );
      expect(width, expected.path + " must retain enough detail for the 2x 308px consumer").toBeGreaterThanOrEqual(616);
      expect(height).toBe(Math.round((width * expected.originalHeight) / expected.originalWidth));
      decodedAssets.push(decoded.scanlines);
    }

    expect(Buffer.compare(decodedAssets[0], decodedAssets[1])).not.toBe(0);
  });

  it("rejects oversized and invalid-PNG controls instead of passing by presence", async () => {
    const isBudgetedDecodedPng = async (bytes: Buffer) => {
      if (bytes.byteLength > fallbackByteBudget) {
        return false;
      }

      try {
        decodeIndexedPng(bytes);
        return true;
      } catch {
        return false;
      }
    };

    expect(await isBudgetedDecodedPng(Buffer.alloc(fallbackByteBudget + 1))).toBe(false);
    expect(await isBudgetedDecodedPng(Buffer.from("not a PNG"))).toBe(false);

    for (const expected of fallbackAssetExpectations) {
      const resolved = await resolvePublicAssetPath(expected.path);
      expect(statSync(resolved).size).toBeLessThanOrEqual(fallbackByteBudget);
    }
  });
});
