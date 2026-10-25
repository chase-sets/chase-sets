import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ObservationPackManifestV1 } from "./observation-pack";
import {
  createPackBackedProviderAdapter,
  foldRepresentativeCatalogObservationHistory,
} from "./representative-catalog-replay";
import { decideSourceObservation, evolveSourceObservation, initialSourceObservationState } from "../../domain/domain";
import { requireCatalogProviderSourceObservation } from "../promotion/provider-source-observation-normalizer";
import { ygojsonYugiohSetReferenceSourceObservationMappingContract } from "../providers/ygojson/executable-mapping-contract";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../tcgdex-executable-mapping-contract";
import tcgdexFixture from "../__fixtures__/tcgdex/normal.json";

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
  it("replays legacy and normalized-evidence-chunked histories with complete evidence", () => {
    const inline = requireCatalogProviderSourceObservation({
      contract: tcgdexPokemonCardSourceObservationMappingContract,
      payload: tcgdexFixture,
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../__fixtures__/ygojson-yugioh-set-reference-data/beginners-edition-2.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    const chunked = requireCatalogProviderSourceObservation({
      contract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
      payload: fixture,
      observedAt: "2026-10-22T00:00:00.000Z",
    });
    const legacy = { ...inline, sourcePayload: { oversized: "legacy source payload ".repeat(20_000) } };
    for (const observation of [inline, legacy, chunked]) {
      const events = decideSourceObservation(initialSourceObservationState, {
        type: "RecordSourceObservation",
        ...observation,
      });
      const rows = events.map((event) => ({ event_type: event.type, payload: event.data }));
      const replayed = foldRepresentativeCatalogObservationHistory(rows, observation);
      expect(replayed).toEqual(events.reduce(evolveSourceObservation, initialSourceObservationState));
      expect(replayed?.normalized).toEqual(observation.normalized);
      expect(replayed?.sourcePayload).toEqual(observation.sourcePayload);
      expect(replayed?.pendingSourcePayloadChunks).toBeNull();
      expect(replayed?.pendingNormalizedEvidenceChunks).toBeNull();
      if (observation === chunked) {
        const incomplete = rows.filter(
          (row) => row.event_type !== "catalog.source-observation.normalized-evidence-chunk-recorded",
        );
        const pending = events
          .filter((event) => event.type !== "catalog.source-observation.normalized-evidence-chunk-recorded")
          .reduce(evolveSourceObservation, initialSourceObservationState);
        expect(pending.pendingNormalizedEvidenceChunks).not.toBeNull();
        expect(pending.pendingSourcePayloadChunks).toBeNull();
        expect(() => foldRepresentativeCatalogObservationHistory(incomplete, observation)).toThrow(
          "representative-catalog-history-invalid",
        );
      }
    }
  });

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
