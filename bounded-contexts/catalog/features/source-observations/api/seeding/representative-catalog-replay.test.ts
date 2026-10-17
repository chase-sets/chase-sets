import { describe, expect, it } from "vitest";

import type { ObservationPackManifestV1 } from "./observation-pack";
import { createPackBackedProviderAdapter } from "./representative-catalog-replay";

const unitKey = "scrydex:one-piece:single-card:source-observation-import";
const manifest = {
  captureContentHash: "sha256:synthetic-adapter-control",
  identity: {
    provider: { key: "scrydex", ingestionUnit: unitKey, integrationProfileVersion: "2026.06.19" },
    productLine: { key: "one-piece-card-game" },
    set: { displayName: "Romance Dawn" },
    language: "en",
    scope: {
      scopeKey: "expansion",
      coordinates: [
        { key: "expansionId", value: "OP01" },
        { key: "languageCode", value: "en" },
      ],
    },
  },
} as unknown as ObservationPackManifestV1;

const request = {
  unitKey: unitKey as never,
  scopeKey: "set",
  values: { setId: "OP01", setCode: "OP01", expansionId: "OP01", languageCode: "en" },
};

describe("pack-backed replay target", () => {
  it("accepts set and expansion labels only for the same unit, coordinate and language", async () => {
    const adapter = createPackBackedProviderAdapter(manifest, []);
    await expect(adapter.planImport(request)).resolves.toMatchObject({
      scope: { scopeKey: "expansion", values: { expansionId: "OP01", languageCode: "en" } },
    });
  });

  it.each([
    ["unit", { ...request, unitKey: "another-unit" }],
    ["coordinate", { ...request, values: { setId: "OP02", languageCode: "en" } }],
    ["language", { ...request, values: { setId: "OP01", languageCode: "ja" } }],
    ["unknown requested family", { ...request, scopeKey: "product" }],
    ["missing requested coordinate", { ...request, values: { languageCode: "en" } }],
    [
      "conflicting requested coordinates",
      { ...request, values: { setId: "OP01", expansionId: "OP02", languageCode: "en" } },
    ],
  ])("refuses %s before fetch", async (_reason, target) => {
    const adapter = createPackBackedProviderAdapter(manifest, []);
    await expect(adapter.planImport(target as never)).rejects.toThrow("representative-catalog-pack-contract-invalid");
  });

  it.each([
    ["unknown manifest family", { scopeKey: "product" }],
    ["missing manifest coordinate", { coordinates: [{ key: "languageCode", value: "en" }] }],
    ["missing manifest language", { coordinates: [{ key: "expansionId", value: "OP01" }] }],
    [
      "different manifest language",
      {
        coordinates: [
          { key: "expansionId", value: "OP01" },
          { key: "languageCode", value: "ja" },
        ],
      },
    ],
    [
      "conflicting manifest coordinates",
      {
        coordinates: [
          { key: "setId", value: "OP02" },
          { key: "expansionId", value: "OP01" },
          { key: "languageCode", value: "en" },
        ],
      },
    ],
  ])("refuses %s before fetch", async (_reason, scope) => {
    const adapter = createPackBackedProviderAdapter(
      {
        ...manifest,
        identity: { ...manifest.identity, scope: { ...manifest.identity.scope, ...scope } },
      },
      [],
    );
    await expect(adapter.planImport(request)).rejects.toThrow("representative-catalog-pack-contract-invalid");
  });
});
