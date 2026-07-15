import { describe, expect, it } from "vitest";
import { ProductionCatalogCompletionManifestError, parseProductionCatalogCompletionManifest } from "./manifest";
import { completeManifest } from "./__fixtures__/manifest";

describe("parseProductionCatalogCompletionManifest", () => {
  it("parses a well-formed manifest into the typed contract", () => {
    const manifest = completeManifest();
    const parsed = parseProductionCatalogCompletionManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed).toEqual(manifest);
  });

  it("rejects an unknown manifest version", () => {
    const raw = { ...completeManifest(), manifestVersion: "production-catalog-completion-manifest-v0" };
    expect(() => parseProductionCatalogCompletionManifest(raw)).toThrow(ProductionCatalogCompletionManifestError);
  });

  it("rejects an unknown exclusion reason and names the offending path", () => {
    const manifest = completeManifest();
    const raw = {
      ...manifest,
      exclusions: [
        { scopeRecordId: "scope-1", providerKey: "scrydex", unitKey: "cards", reason: "made-up", note: null },
      ],
    };
    try {
      parseProductionCatalogCompletionManifest(raw);
      expect.unreachable("expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionCatalogCompletionManifestError);
      expect((error as ProductionCatalogCompletionManifestError).issues.join(" ")).toContain("exclusions.0.reason");
    }
  });

  it("rejects a negative count", () => {
    const raw = { ...completeManifest(), catalogItems: { draft: -1, published: 5 } };
    expect(() => parseProductionCatalogCompletionManifest(raw)).toThrow(ProductionCatalogCompletionManifestError);
  });
});
