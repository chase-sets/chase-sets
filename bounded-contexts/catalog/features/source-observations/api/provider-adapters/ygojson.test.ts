import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ProviderPayloadEnvelope } from "./provider-adapter";
import {
  createYgojsonProviderAdapter,
  runYgojsonSealedProductReferenceValidationDryRun,
  runYgojsonSetReferenceValidationDryRun,
  YGOJSON_VALIDATION_PROFILE_VERSION,
  YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
  YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  type YgojsonProviderPayload,
} from "./ygojson";

const fixtureBaseUrl = "https://fixture.chase-sets.local/ygojson";

describe("YGOJSON provider adapter", () => {
  it("serves Yu-Gi-Oh set and sealed-product options through fixture-backed public JSON fetches", async () => {
    const adapter = createYgojsonProviderAdapter({
      baseUrl: fixtureBaseUrl,
      fetch: ygojsonFixtureFetch(),
      now: () => new Date("2026-06-21T00:00:00.000Z"),
      profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual([
      {
        unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "ygojson",
        productDomain: "yugioh",
        productForm: "set",
        ingestionPurpose: "reference-data",
        displayName: "YGOJSON Yu-Gi-Oh set reference data",
        profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
      },
      {
        unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
        providerKey: "ygojson",
        productDomain: "yugioh",
        productForm: "sealed-product",
        ingestionPurpose: "reference-data",
        displayName: "YGOJSON Yu-Gi-Oh sealed-product reference data",
        profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
      },
    ]);
    await expect(
      adapter.listOptions({
        unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
        optionKind: "sets",
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "11111111-1111-4111-8111-111111111111",
          label: "Legend of Blue Eyes White Dragon",
          metadata: {
            releaseDate: "2002-03-08",
            localeCount: "1",
            printCount: "1",
            yugipediaId: "12345",
          },
        },
      ],
    });
    await expect(
      adapter.listOptions({
        unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
        optionKind: "sealed-products",
      }),
    ).resolves.toEqual({
      items: [
        {
          value: "22222222-2222-4222-8222-222222222222",
          label: "Legend of Blue Eyes White Dragon Booster Box",
          metadata: {
            releaseDate: "2002-03-08",
            localeCount: "1",
            boxOfSetCount: "1",
            packContentEvidenceCount: "24",
            yugipediaId: "67890",
          },
        },
      ],
    });
  });

  it("plans imports and emits payload envelopes with provenance for one set and one sealed product", async () => {
    const progress: unknown[] = [];
    const adapter = createYgojsonProviderAdapter({
      baseUrl: fixtureBaseUrl,
      fetch: ygojsonFixtureFetch(),
      now: () => new Date("2026-06-21T00:00:00.000Z"),
      profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
    });
    const setPlan = await adapter.planImport({
      unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set",
      values: { setId: "11111111-1111-4111-8111-111111111111" },
    });
    const sealedProductPlan = await adapter.planImport({
      unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "sealed-product",
      values: { sealedProductId: "22222222-2222-4222-8222-222222222222" },
    });
    const payloads = [
      ...(await collectPayloads(
        adapter.fetchPayloads(setPlan, {
          onProgress: (event) => {
            progress.push(event);
          },
        }),
      )),
      ...(await collectPayloads(adapter.fetchPayloads(sealedProductPlan))),
    ];

    expect(setPlan).toMatchObject({
      unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      planKey: "ygojson:set:11111111-1111-4111-8111-111111111111",
      transportSteps: ["Fetch YGOJSON set file", "Attach set reference provenance"],
    });
    expect(sealedProductPlan).toMatchObject({
      unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
      planKey: "ygojson:sealed-product:22222222-2222-4222-8222-222222222222",
      transportSteps: ["Fetch YGOJSON sealed product file", "Attach sealed-product reference provenance"],
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "ygojson",
        externalKey: "set:11111111-1111-4111-8111-111111111111",
        payload: expect.objectContaining({ kind: "set-reference" }),
        provenance: expect.objectContaining({
          sourceUrl:
            "https://fixture.chase-sets.local/ygojson/individual/sets/11111111-1111-4111-8111-111111111111.json",
          sourceUpdatedAt: "2002-03-08",
          fetchedAt: "2026-06-21T00:00:00.000Z",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
      expect.objectContaining({
        unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
        providerKey: "ygojson",
        externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
        payload: expect.objectContaining({ kind: "sealed-product-reference" }),
        provenance: expect.objectContaining({
          sourceUrl:
            "https://fixture.chase-sets.local/ygojson/individual/sealedProducts/22222222-2222-4222-8222-222222222222.json",
          sourceUpdatedAt: "2002-03-08",
          fetchedAt: "2026-06-21T00:00:00.000Z",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(progress).toEqual([
      { phase: "fetching", completed: 1, total: 1, currentLabel: "Legend of Blue Eyes White Dragon" },
    ]);
  });

  it("proves YGOJSON set and sealed-product dry runs while keeping contents as evidence", async () => {
    const adapter = createYgojsonProviderAdapter({
      baseUrl: fixtureBaseUrl,
      fetch: ygojsonFixtureFetch(),
      now: () => new Date("2026-06-21T00:00:00.000Z"),
      profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
    });
    const setDryRun = await runYgojsonSetReferenceValidationDryRun(adapter);
    const sealedProductDryRun = await runYgojsonSealedProductReferenceValidationDryRun(adapter);

    expect(setDryRun).toMatchObject({
      unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
      observations: [
        {
          providerKey: "ygojson",
          externalKey: "set:11111111-1111-4111-8111-111111111111",
          normalizedFacts: {
            productLineName: "Yu-Gi-Oh!",
            name: "Legend of Blue Eyes White Dragon",
            ygojsonId: "11111111-1111-4111-8111-111111111111",
            releaseDate: "2002-03-08",
            localeCount: "1",
            printCount: "1",
            packContentEvidenceCount: "0",
            yugipediaId: "12345",
          },
        },
      ],
      diagnostics: [],
    });
    expect(sealedProductDryRun).toMatchObject({
      unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
      profileVersion: YGOJSON_VALIDATION_PROFILE_VERSION,
      observations: [
        {
          providerKey: "ygojson",
          externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
          normalizedFacts: {
            productLineName: "Yu-Gi-Oh!",
            name: "Legend of Blue Eyes White Dragon Booster Box",
            ygojsonId: "22222222-2222-4222-8222-222222222222",
            releaseDate: "2002-03-08",
            localeCount: "1",
            boxOfSetCount: "1",
            packContentEvidenceCount: "24",
            yugipediaId: "67890",
          },
        },
      ],
      diagnostics: [],
    });
    expect(JSON.stringify([setDryRun, sealedProductDryRun])).not.toMatch(/price|vendor|market/i);
  });
});

async function collectPayloads(
  payloads: AsyncIterable<ProviderPayloadEnvelope<YgojsonProviderPayload>>,
): Promise<ProviderPayloadEnvelope<YgojsonProviderPayload>[]> {
  const collected: ProviderPayloadEnvelope<YgojsonProviderPayload>[] = [];

  for await (const payload of payloads) {
    collected.push(payload);
  }

  return collected;
}

function ygojsonFixtureFetch(): typeof globalThis.fetch {
  const set = readFixturePayload("../__fixtures__/ygojson-yugioh-set-reference-data/normal.json", "set");
  const sealedProduct = readFixturePayload(
    "../__fixtures__/ygojson-yugioh-sealed-product-reference-data/normal.json",
    "sealedProduct",
  );
  const responses: Readonly<Record<string, unknown>> = {
    [`${fixtureBaseUrl}/aggregate/sets.json`]: [set],
    [`${fixtureBaseUrl}/aggregate/sealedProducts.json`]: [sealedProduct],
    [`${fixtureBaseUrl}/individual/sets/11111111-1111-4111-8111-111111111111.json`]: set,
    [`${fixtureBaseUrl}/individual/sealedProducts/22222222-2222-4222-8222-222222222222.json`]: sealedProduct,
  };

  return async (input) => {
    const response = responses[String(input)];
    return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
  };
}

function readFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")) as unknown;
}

function readFixturePayload(relativePath: string, payloadKey: "set" | "sealedProduct"): unknown {
  const fixture = readFixture(relativePath);
  if (!isFixtureObject(fixture) || !(payloadKey in fixture)) {
    throw new Error(`YGOJSON adapter fixture ${relativePath} is missing ${payloadKey}.`);
  }

  return fixture[payloadKey];
}

function isFixtureObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
