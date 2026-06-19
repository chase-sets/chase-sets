import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";
import {
  formatCatalogProviderNormalizationDiagnostics,
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import { scrydexScryfallCardSourceObservationMappingContract } from "./scrydex-executable-mapping-contract";
import {
  scryfallMtgCardPrintSourceObservationMappingContract,
  scryfallMtgImageEvidenceSourceObservationMappingContract,
} from "./scryfall-executable-mapping-contract";

describe("provider Source Observation normalizer", () => {
  it("builds a provider-product Source Observation from mapping config", () => {
    const contract = providerProductContract();

    const result = normalizeCatalogProviderSourceObservation({
      contract,
      payload: providerProductPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation).toMatchObject({
      observationId: "tcgplayer_en_product_610001",
      providerKey: "tcgplayer",
      externalKey: "product:610001",
      sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
      languageCode: "en",
      sourceUpdatedAt: "2025-01-17",
      normalized: {
        kind: "provider-product",
        providerProductId: "610001",
        providerProductName: "Eevee ex",
        name: "Eevee ex",
        cardNumber: "167/131",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      },
    });
    expect(result.observation?.sourceRecordHash).toHaveLength(64);
  });

  it("keeps price and listing signals out of configured hash material", () => {
    const contract = providerProductContract();
    const base = providerProductPayload();
    const repriced = {
      ...base,
      marketPrice: 10_000,
      lowestPrice: 9_999,
      listings: 999,
    };

    const original = normalizeCatalogProviderSourceObservation({
      contract,
      payload: base,
      observedAt: "2026-06-03T00:00:00.000Z",
    });
    const changed = normalizeCatalogProviderSourceObservation({
      contract,
      payload: repriced,
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(changed.observation?.sourceRecordHash).toBe(original.observation?.sourceRecordHash);
  });

  it("reports missing required fields without leaking provider values", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: providerProductContract(),
      payload: {
        productId: 610001,
        productName: "Secret Rare Cookie",
        auth: { cookie: "TCGAuthTicket_Production=do-not-log" },
      },
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    const text = formatCatalogProviderNormalizationDiagnostics("tcgplayer", result.diagnostics);

    expect(result.observation).toBeNull();
    expect(text).toContain("tcgplayer");
    expect(text).not.toContain("Secret Rare Cookie");
    expect(text).not.toContain("TCGAuthTicket_Production");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-required-path",
          path: "normalizedObservation.fields.setName.selector.path",
        }),
      ]),
    );
  });

  it("builds a Scrydex magic-card-print observation with Scryfall card print identity", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: scrydexScryfallCardSourceObservationMappingContract,
      payload: scrydexScryfallCardPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation).toMatchObject({
      observationId: "scrydex_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUrl: "https://scryfall.com/card/tsp/157/fury-sliver",
      languageCode: "en",
      sourceUpdatedAt: "2006-10-06",
      normalized: {
        kind: "magic-card-print",
        tcg: "magic",
        name: "Fury Sliver",
        setCode: "tsp",
        setName: "Time Spiral",
        cardNumber: "157",
        oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
        releaseDate: "2006-10-06",
        cardVariantKey: "standard",
        cardVariantLabel: "Standard",
        imageUrls: [
          "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
          "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
        ],
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        mergeIdentity: {
          tcg: "magic",
          productLineName: "Magic: The Gathering",
          setName: "Time Spiral",
          printedProductName: "Fury Sliver",
          collectorNumber: "157",
          languageCode: "en",
          productForm: "magic-card-print",
        },
      },
    });
    expect(result.observation?.sourceRecordHash).toHaveLength(64);
  });

  it("builds production Scryfall observations from wrapped adapter payloads", () => {
    const cardPayload = scryfallWrappedCardPayload();
    const card = cardPayload.card as JsonObject;
    const cardResult = normalizeCatalogProviderSourceObservation({
      contract: scryfallMtgCardPrintSourceObservationMappingContract,
      payload: cardPayload,
      observedAt: "2026-06-19T00:00:00.000Z",
    });
    const imageResult = normalizeCatalogProviderSourceObservation({
      contract: scryfallMtgImageEvidenceSourceObservationMappingContract,
      payload: {
        kind: "image-evidence",
        card,
        imageUris: card.image_uris,
      },
      observedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(cardResult.diagnostics).toEqual([]);
    expect(cardResult.observation).toMatchObject({
      observationId: "scryfall_card_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUrl: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-print-reference-data",
      sourceProfileVersion: "2026.06.19",
      normalized: {
        kind: "magic-card-print",
        tcg: "magic",
        name: "Fury Sliver",
        setCode: "tsp",
        setName: "Time Spiral",
        cardNumber: "157",
        oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
        illustrator: "Pete Venters",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
      },
      sourcePayload: expect.objectContaining({ kind: "single-card" }),
    });
    expect(imageResult.diagnostics).toEqual([]);
    expect(imageResult.observation).toMatchObject({
      observationId: "scryfall_image_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      providerKey: "scryfall",
      externalKey: "image:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-image-evidence",
      normalized: {
        kind: "magic-card-print",
        imageUrls: [
          "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
          "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
        ],
      },
    });
  });

  it("blocks incomplete magic-card-print observations with actionable normalized field diagnostics", () => {
    const contract: CatalogProviderSourceObservationMappingContract = {
      ...scrydexScryfallCardSourceObservationMappingContract,
      normalizedObservation: {
        ...scrydexScryfallCardSourceObservationMappingContract.normalizedObservation,
        fields: {
          ...scrydexScryfallCardSourceObservationMappingContract.normalizedObservation.fields,
          setCode: optionalExpr("missing_set_code", "catalog-truth", ["normalized-observation"]),
        },
      },
    };

    const result = normalizeCatalogProviderSourceObservation({
      contract,
      payload: scrydexScryfallCardPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.observation).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "transform-type-mismatch",
          path: "normalizedObservation.fields.setCode",
          diagnosticText: expect.stringContaining("setCode"),
        }),
      ]),
    );
  });
});

function scrydexScryfallCardPayload(): JsonObject {
  return {
    object: "card",
    id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
    oracle_id: "44623693-51d6-49ad-8cd7-140505caf02f",
    name: "Fury Sliver",
    lang: "en",
    released_at: "2006-10-06",
    scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
    set: "tsp",
    set_name: "Time Spiral",
    collector_number: "157",
    image_uris: {
      normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
      png: "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
    },
    tcgplayer_id: 14240,
  };
}

function scryfallWrappedCardPayload(): JsonObject {
  return {
    kind: "single-card",
    card: {
      ...scrydexScryfallCardPayload(),
      uri: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      set_id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
      artist: "Pete Venters",
    },
  };
}

function providerProductPayload(): JsonObject {
  return {
    productId: 610001,
    productName: "Eevee ex",
    productLineName: "Pokemon",
    productTypeName: "Cards",
    setName: "Prismatic Evolutions",
    releaseDate: "2025-01-17",
    customAttributes: { number: "167/131" },
    sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
    externalKey: "product:610001",
    observationId: "tcgplayer_en_product_610001",
    catalogHashMaterial: {
      productId: 610001,
      productName: "Eevee ex",
      setName: "Prismatic Evolutions",
      number: "167/131",
    },
  };
}

function providerProductContract(): CatalogProviderSourceObservationMappingContract {
  return {
    ...baseContract(),
    sourceObservation: {
      observationId: expr("observationId", "catalog-merge-evidence", ["normalized-observation"]),
      externalKey: expr("externalKey", "external-reference", ["external-reference"]),
      sourceUrl: expr("sourceUrl", "operations", ["source-payload"]),
      sourceUpdatedAt: optionalExpr("releaseDate", "catalog-truth", ["normalized-observation"]),
      sourcePayload: expr(".", "catalog-merge-evidence", ["source-payload"]),
    },
    normalizedObservation: {
      outputKind: "provider-product",
      languageCode: constantExpr("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        name: expr("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
        setName: expr("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
        expansionName: expr("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
        cardNumber: expr("customAttributes.number", "catalog-truth", ["normalized-observation", "hash-material"]),
        imageUrls: constantExpr([], "catalog-truth", ["normalized-observation"]),
        providerProductId: expr("productId", "external-reference", ["normalized-observation", "hash-material"], {
          transforms: [{ kind: "coerce", to: "string" }],
        }),
        providerProductName: expr("productName", "catalog-truth", ["normalized-observation"]),
        productLineName: expr("productLineName", "catalog-merge-evidence", ["normalized-observation"]),
        productCategoryName: expr("productTypeName", "catalog-merge-evidence", ["normalized-observation"]),
        skuReferences: constantExpr([], "external-reference", ["normalized-observation"]),
        externalCatalogItemReferences: constantExpr(
          [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
          "external-reference",
          ["normalized-observation", "external-reference"],
        ),
      },
      hashMaterial: [expr("catalogHashMaterial", "catalog-truth", ["hash-material"])],
      mergeIdentity: [],
    },
  };
}

function baseContract(): Omit<CatalogProviderExecutableMappingContract, "sourceObservation" | "normalizedObservation"> {
  return {
    providerKey: "tcgplayer",
    profileKey: "tcgplayer-test",
    displayName: "TCGplayer Test",
    profileVersion: "2026.06.03",
    lifecycle: "test",
    sourceContract: {
      owner: "Catalog",
      repository: null,
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-mapping-contract.md",
      fixtureSetVersion: "test",
    },
    connector: {
      kind: "tcgplayer-automation-client",
      transportOwns: ["raw-provider-parse"],
      mappingOwns: ["normalized-observation", "hash-material", "merge-identity"],
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer",
      coveredFlows: [
        "normal",
        "partial",
        "stale",
        "changed",
        "ambiguous",
        "replay",
        "sealed-product",
        "unknown-option",
      ],
      liveProviderCallsAllowed: false,
    },
    externalReferences: [],
    referenceHierarchy: [],
    duplicatePrevention: {
      exactExternalCatalogItemReferencesFirst: true,
      mergeCandidateEvidence: [],
      identityRules: [],
      ambiguousCandidatePolicy: "block-promotion",
      replayPolicy: "same-profile-version",
    },
    promotionCommandPlan: {
      planKind: "catalog-item-promotion",
      requiresReview: true,
      commands: [],
    },
    nonGoals: [
      "no-live-provider-calls-in-mapping-tests",
      "no-pricing-facts-as-catalog-truth",
      "no-inventory-facts-as-global-catalog-truth",
      "no-provider-secrets-in-events-logs-or-fixtures",
      "no-provider-transport-branches-in-mapping-interpreter",
    ],
  };
}

function expr(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function optionalExpr(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: false,
      nullPolicy: "allow-null",
    },
    owner,
    uses,
    redaction: "none",
  };
}

function constantExpr(
  value: JsonValue,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "constant",
      value,
    },
    owner,
    uses,
    redaction: "none",
  };
}
