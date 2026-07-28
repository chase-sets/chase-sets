import { describe, expect, it } from "vitest";

import { runCatalogIntegrationDryRun } from "./catalog-integration-engine";
import type { ProviderPayloadEnvelope } from "../provider-adapters/provider-adapter";

type ReferenceCardPayload = Readonly<{
  providerCardId: string;
  name: string;
}>;

const unitKey = "reference-cards:pokemon:single-card:source-observation-proof";

describe("Catalog Integration Engine", () => {
  it("turns reference provider payloads into Source Observation facts without live provider calls", () => {
    const result = runCatalogIntegrationDryRun({
      unitKey,
      profileVersion: "2026.06.05-reference",
      payloads: [
        {
          unitKey,
          providerKey: "reference-cards",
          externalKey: "abra-43",
          payload: { providerCardId: "abra-43", name: "Abra 43/102" },
          provenance: {
            fetchedAt: "2026-06-05T00:00:00.000Z",
            sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
            contentHash: "reference-hash-abra-43",
          },
        },
      ],
      normalize: toReferenceObservationFact,
    });

    expect(result).toEqual({
      unitKey,
      profileVersion: "2026.06.05-reference",
      observations: [
        {
          unitKey,
          providerKey: "reference-cards",
          externalKey: "abra-43",
          profileVersion: "2026.06.05-reference",
          normalizedFacts: {
            cardName: "Abra 43/102",
            providerCardId: "abra-43",
          },
          sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
          sourceHash: "reference-hash-abra-43",
        },
      ],
      diagnostics: [],
    });
  });

  it("diagnoses payloads that do not belong to the requested ingestion unit", () => {
    const result = runCatalogIntegrationDryRun({
      unitKey,
      profileVersion: "2026.06.05-reference",
      payloads: [
        {
          unitKey: "reference-cards:mtg:single-card:source-observation-proof",
          providerKey: "reference-cards",
          externalKey: "fury-sliver",
          payload: { providerCardId: "fury-sliver", name: "Fury Sliver" },
          provenance: { fetchedAt: "2026-06-05T00:00:00.000Z" },
        },
      ],
      normalize: toReferenceObservationFact,
    });

    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "integration-unit-mismatch",
        severity: "error",
        diagnosticText: "Provider payload was produced for a different Catalog integration unit.",
        unitKey,
        externalKey: "fury-sliver",
        path: "payload.unitKey",
      },
    ]);
  });

  it("diagnoses normalized facts that do not preserve engine input identity", () => {
    const result = runCatalogIntegrationDryRun({
      unitKey,
      profileVersion: "2026.06.05-reference",
      payloads: [
        {
          unitKey,
          providerKey: "reference-cards",
          externalKey: "abra-43",
          payload: { providerCardId: "abra-43", name: "Abra 43/102" },
          provenance: { fetchedAt: "2026-06-05T00:00:00.000Z" },
        },
      ],
      normalize: (payload) => ({
        ...toReferenceObservationFact(payload),
        profileVersion: "wrong-profile-version",
      }),
    });

    expect(result.observations).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "normalized-observation-identity-mismatch",
        severity: "error",
        diagnosticText: "Normalized Source Observation fact does not preserve engine input identity.",
        unitKey,
        externalKey: "abra-43",
        path: "normalize",
      },
    ]);
  });
});

function toReferenceObservationFact(payload: ProviderPayloadEnvelope<ReferenceCardPayload>) {
  return {
    unitKey: payload.unitKey,
    providerKey: payload.providerKey,
    externalKey: payload.externalKey,
    profileVersion: "2026.06.05-reference",
    normalizedFacts: {
      cardName: payload.payload.name,
      providerCardId: payload.payload.providerCardId,
    },
    sourceUrl: payload.provenance.sourceUrl,
    sourceHash: payload.provenance.contentHash,
  };
}
