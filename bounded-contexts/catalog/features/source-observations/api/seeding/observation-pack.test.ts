import { describe, expect, it } from "vitest";

import {
  OBSERVATION_PACK_DECISION_LINK,
  buildObservationPack,
  observationPackEnvelopeContentHash,
  recordObservationPackAcceptance,
  sanitizeObservationPackEnvelope,
  verifyObservationPack,
  writeObservationPack,
  type ObservationPackObjectStorage,
} from "./observation-pack";
import { captureObservationPack } from "./observation-pack-capture";
import {
  createScryfallValidationProviderAdapter,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/scryfall";

describe("Observation Pack manifest v1", () => {
  it("captures transport envelopes through the executable provider adapter", async () => {
    const bundle = await captureObservationPack({
      definition: {
        packId: "scryfall-mtg-time-spiral-en",
        providerKey: "scryfall",
        unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        scope: {
          unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
          scopeKey: "set",
          values: { languageCode: "en", setCode: "tsp" },
        },
        identity: {
          productLineKey: "magic-the-gathering",
          productLineDisplayName: "Magic: The Gathering",
          setKind: "set",
          setExternalId: "tsp",
          setDisplayName: "Time Spiral",
          providerKey: "scryfall",
          language: "en",
          scopeKey: "set",
          scopeCoordinates: { languageCode: "en", setCode: "tsp" },
        },
      },
      profile: { profileKey: "mtg-card-print-reference-data", profileVersion: "2026.06.19" },
      adapter: createScryfallValidationProviderAdapter(),
      packVersion: "v1-adapter-proof",
      capturedAt: "2026-07-22T18:00:00-05:00",
      fetch: async () =>
        new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      credentialValues: ["credential-that-must-never-appear"],
    });

    const chunk = JSON.parse(
      new TextDecoder().decode(bundle.files.find((file) => file.path.startsWith("payloads/"))?.body),
    );
    expect(chunk.envelopes[0]).toMatchObject({
      providerKey: "scryfall",
      externalKey: expect.stringMatching(/^card:/),
      payload: { kind: "single-card", card: { set: "tsp" } },
    });
    expect(chunk.envelopes[0]).not.toHaveProperty("normalizedFacts");
    expect(JSON.stringify(chunk)).not.toMatch(/prices|market_price|credential-that-must-never-appear/i);
    expect(bundle.manifest.assets.length).toBeGreaterThan(0);
  });

  it("sanitizes the adapter envelope, strips commerce fields, and verifies the captured fixture wrapper", async () => {
    const envelope = sanitizeObservationPackEnvelope(providerEnvelope());
    expect(JSON.stringify(envelope)).not.toMatch(/price|market|inventory|quantity|listing/i);
    expect(JSON.stringify(envelope)).not.toContain("credential-value");
    expect(envelope.payload).toMatchObject({ authorization: "<redacted>" });

    const bundle = packBundle(envelope);
    const storage = memoryStorage();
    const write = await writeObservationPack({ storage, prefix: "arbitrary/location", bundle });
    const verification = await verifyObservationPack({ storage, manifestKey: write.manifestKey });

    expect(verification).toMatchObject({
      valid: true,
      posture: "captured",
      replayEligible: false,
      diagnostics: [],
      counts: { entryChunks: 1, envelopes: 1, assets: 1 },
    });
  });

  it("records acceptance without changing immutable capture content", async () => {
    const bundle = packBundle(sanitizeObservationPackEnvelope(providerEnvelope()));
    const accepted = recordObservationPackAcceptance(bundle.manifest, {
      acceptedBy: "Todd",
      acceptedAt: "2026-07-22T18:30:00-05:00",
      decisionLink: OBSERVATION_PACK_DECISION_LINK,
    });

    expect(accepted.captureContentHash).toBe(bundle.manifest.captureContentHash);
    expect(accepted.entries).toEqual(bundle.manifest.entries);
    expect(accepted.assets).toEqual(bundle.manifest.assets);
    expect(accepted.governance.lifecycle).toMatchObject({
      state: "accepted",
      acceptance: { acceptedBy: "Todd", decisionLink: OBSERVATION_PACK_DECISION_LINK },
    });
    expect(accepted.governance.fixtureRecord.validationStatus).toBe("valid");
    expect(() =>
      recordObservationPackAcceptance(accepted, {
        acceptedBy: "another-operator",
        acceptedAt: "2026-07-22T18:31:00-05:00",
        decisionLink: OBSERVATION_PACK_DECISION_LINK,
      }),
    ).toThrow("immutable");
  });

  it("rejects an acceptance instant before capture", () => {
    const bundle = packBundle(sanitizeObservationPackEnvelope(providerEnvelope()));
    expect(() =>
      recordObservationPackAcceptance(bundle.manifest, {
        acceptedBy: "Todd",
        acceptedAt: "2026-07-21T23:59:59Z",
        decisionLink: OBSERVATION_PACK_DECISION_LINK,
      }),
    ).toThrow("precede");
  });
});

function packBundle(envelope: ReturnType<typeof sanitizeObservationPackEnvelope>) {
  return buildObservationPack({
    packId: "provider-product-line-set-en",
    packVersion: "v1-20260722T180000Z",
    capturedAt: "2026-07-22T18:00:00-05:00",
    identity: {
      productLineKey: "product-line",
      productLineDisplayName: "Product Line",
      setKind: "set",
      setExternalId: "set-1",
      setDisplayName: "Set One",
      providerKey: "provider",
      integrationProfileKey: "provider-profile",
      integrationProfileVersion: "2026.07.22",
      ingestionUnit: "provider:product-line:single-card:source-observation-import",
      language: "en",
      scopeKey: "set",
      scopeCoordinates: { languageCode: "en", setId: "set-1" },
    },
    envelopes: [envelope],
    assets: [
      {
        bytes: new TextEncoder().encode("image-bytes"),
        mediaType: "image/png",
        sourceReference: "https://images.example.invalid/card.png",
        envelopeContentHashes: [observationPackEnvelopeContentHash(envelope)],
      },
    ],
  });
}

function providerEnvelope() {
  return {
    unitKey: "provider:product-line:single-card:source-observation-import",
    providerKey: "provider",
    externalKey: "card:1",
    payload: {
      kind: "provider-card",
      name: "Card One",
      price: "12.00",
      market_price: "11.00",
      inventory: 4,
      quantity: 2,
      listingId: "listing-1",
      authorization: "credential-value",
      imageUrls: ["https://images.example.invalid/card.png"],
    },
    provenance: {
      sourceUrl: "https://provider.example.invalid/cards/1",
      fetchedAt: "2026-07-22T18:00:00-05:00",
    },
  } as const;
}

function memoryStorage(): ObservationPackObjectStorage {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    async putObject(input) {
      objects.set(input.key, { body: new Uint8Array(input.body), contentType: input.contentType });
      return {};
    },
    async getObject(key) {
      return objects.get(key) ?? null;
    },
  };
}
