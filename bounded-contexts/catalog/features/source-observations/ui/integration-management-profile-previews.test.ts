import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  duplicatePreventionPreview,
  externalReferencePreview,
  optionQueryStatusDetails,
  providerOptionImportSurface,
  providerOptionMetadataPreview,
  providerOptionOutputPreview,
  providerOptionParentPreview,
  providerOptionSamplePreview,
  promotionCommandRequiredInputKeys,
  promotionPlanPreview,
  referenceHierarchyPreview,
} from "./integration-management-page";
import type { MappingExpressionValue } from "./mapping-expression-editor";

describe("Integration Management profile previews", () => {
  it("builds provider option import surface preview text", () => {
    const tcgplayerSetQuery = {
      id: "set-names-1",
      queryKind: "set-names",
      aliasesText: "set-name, sets",
      displayName: "Set Name",
      scope: "set-name",
      parentScope: "product-line/category",
      parentRequired: true,
      parentValueKind: "product-line-id",
      parentDiagnosticText: "Choose a product line first.",
      operation: "tcgplayer-list-set-names",
      valuePath: "cleanSetName",
      labelPath: "name",
      descriptionKind: "tcgplayer-set-name",
      descriptionPath: "",
      parentValuePath: "$parentValue",
      imageUrlPath: "",
      imageUrlCoalescePathsText: "",
      metadataPathsText: "productLineId=$parentValueNumber\ncleanSetName=cleanSetName",
    };

    expect(providerOptionImportSurface("tcgplayer", tcgplayerSetQuery)).toBe(
      "Pull Provider Data: TCGplayer set selector after product line.",
    );
    expect(providerOptionParentPreview(tcgplayerSetQuery)).toBe(
      "product-line/category requires product-line-id; parent output path: $parentValue.",
    );
    expect(providerOptionOutputPreview(tcgplayerSetQuery)).toBe(
      "value: cleanSetName; label: name; description kind: tcgplayer-set-name; no image.",
    );
    expect(providerOptionMetadataPreview(tcgplayerSetQuery)).toBe(
      "productLineId=$parentValueNumber, cleanSetName=cleanSetName",
    );

    expect(
      providerOptionImportSurface("tcgdex", {
        ...tcgplayerSetQuery,
        id: "series-1",
        queryKind: "series",
        aliasesText: "serie",
        displayName: "Series",
        scope: "series",
        parentScope: "language",
        parentRequired: false,
        parentValueKind: "language-code",
        operation: "tcgdex-list-series",
        valuePath: "seriesId",
        labelPath: "name",
        descriptionKind: "__none__",
        parentValuePath: "$languageCode",
        metadataPathsText: "languageCode=$languageCode\nseriesId=seriesId",
      }),
    ).toBe("Pull Provider Data: TCGdex series selector after language.");
  });

  it("summarizes provider option cache and pagination state", () => {
    const details = optionQueryStatusDetails([
      {
        items: [],
        total: 2,
        count: 1,
        page: {
          cursor: null,
          nextCursor: "offset:1",
          limit: 1,
          hasMore: true,
        },
        cache: {
          status: "stale",
          source: "cache",
          cacheKey: "sha256:test",
          fetchedAt: "2026-06-08T10:00:00.000Z",
          expiresAt: "2026-06-08T10:15:00.000Z",
          staleUntil: "2026-06-09T10:00:00.000Z",
          cacheOnly: true,
          forceRefresh: false,
          degraded: true,
          diagnostics: [],
        },
      },
    ]);

    expect(details).toMatchObject({ degraded: true });
    expect(details?.description).toContain("cache-only mode");
    expect(details?.description).toContain("Stale cached options");
    expect(details?.description).toContain("cursor pagination");
  });

  it("builds provider option sample output previews from fixture payloads", () => {
    const preview = providerOptionSamplePreview(
      {
        id: "set-names-1",
        queryKind: "set-names",
        aliasesText: "set-name, sets",
        displayName: "Set Name",
        scope: "set-name",
        parentScope: "product-line/category",
        parentRequired: true,
        parentValueKind: "product-line-id",
        parentDiagnosticText: "Choose a product line first.",
        operation: "tcgplayer-list-set-names",
        valuePath: "cleanSetName",
        labelPath: "name",
        descriptionKind: "tcgplayer-set-name",
        descriptionPath: "",
        parentValuePath: "productLineId",
        imageUrlPath: "missingImage",
        imageUrlCoalescePathsText: "image.url, fallbackImageUrl",
        metadataPathsText: "productLineId=productLineId\ncleanSetName=cleanSetName\nmissing=missing.value",
      },
      {
        productLineId: 3,
        cleanSetName: "prismatic-evolutions",
        name: "Prismatic Evolutions",
        image: { url: "" },
        fallbackImageUrl: "https://images.example/prismatic.png",
      },
    );

    expect(preview.output).toEqual({
      value: "prismatic-evolutions",
      label: "Prismatic Evolutions",
      parentValue: 3,
      imageUrl: null,
      coalescedImageUrl: "https://images.example/prismatic.png",
      metadata: {
        productLineId: 3,
        cleanSetName: "prismatic-evolutions",
        missing: null,
      },
    });
    expect(preview.diagnostics).toEqual(
      expect.arrayContaining([
        "image URL path: Preview path 'missingImage' was not found.",
        "metadata path 'missing': Preview path 'missing.value' was not found.",
      ]),
    );
  });

  it("builds external reference previews from fixture payloads", () => {
    const preview = externalReferencePreview(
      {
        extractionRules: {},
        contracts: [
          {
            id: "catalog-item-reference",
            target: "catalog-item-reference",
            providerKey: "tcgplayer",
            externalKeyPrefix: "product:",
            source: mappingExpression("externalCatalogItemReferences", "external-reference", [
              "external-reference",
            ]) as MappingExpressionValue,
            ambiguityPolicy: "skip-reference",
            selectedOptions: null,
          },
          {
            id: "product-reference",
            target: "product-reference",
            providerKey: "tcgplayer",
            externalKeyPrefix: "sku:",
            source: mappingExpression("externalProductReferences", "external-reference", [
              "external-reference",
            ]) as MappingExpressionValue,
            ambiguityPolicy: "review-evidence",
            selectedOptions: {
              missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
              dimensions: [
                {
                  id: "condition",
                  dimensionKey: "condition",
                  providerValue: mappingExpression("condition", "external-reference", [
                    "selected-option",
                  ]) as MappingExpressionValue,
                  optionLookupTableKey: "catalog-condition",
                  required: true,
                },
              ],
            },
          },
        ],
        selectedOptionMapping: {
          source: "tcgplayer-sku-condition",
          providerKey: "tcgplayer",
          externalKeyPrefix: "sku:",
          requiredSourceKeysText: "sku, condition",
          missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
          dimensions: [
            {
              id: "condition-record",
              dimensionKey: "condition",
              providerValueSource: "record",
              providerValuePath: "condition",
              required: true,
              optionAliasesText: "near-mint=Near Mint,NM",
              valueMappingsText: "",
            },
          ],
        },
      },
      { externalCatalogItemReferences: 14240, externalProductReferences: 610001, condition: "Near Mint" },
    );

    expect(preview.catalogItemReferences).toEqual([
      expect.objectContaining({ providerKey: "tcgplayer", externalKey: "product:14240" }),
    ]);
    expect(preview.productReferences).toEqual([
      expect.objectContaining({
        providerKey: "tcgplayer",
        externalKey: "sku:610001",
        selectedOptions: [expect.objectContaining({ dimension: "condition", providerValue: "Near Mint" })],
      }),
    ]);
    expect(preview.selectedOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ dimension: "condition", providerValue: "Near Mint" })]),
    );
  });

  it("previews unknown selected options as review evidence unless policy is diagnostic", () => {
    const preview = externalReferencePreview(
      {
        extractionRules: {},
        contracts: [
          {
            id: "product-reference",
            target: "product-reference",
            providerKey: "tcgplayer",
            externalKeyPrefix: "sku:",
            source: mappingExpression("sku", "external-reference", ["external-reference"]) as MappingExpressionValue,
            ambiguityPolicy: "review-evidence",
            selectedOptions: {
              missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
              dimensions: [
                {
                  id: "printing",
                  dimensionKey: "printing",
                  providerValue: mappingExpression("printing", "external-reference", [
                    "selected-option",
                  ]) as MappingExpressionValue,
                  optionLookupTableKey: "catalog-printing",
                  required: true,
                },
              ],
            },
          },
        ],
        selectedOptionMapping: null,
      },
      { sku: 610001, printing: "Confetti Galaxy Foil" },
    );

    expect(preview.productReferences).toEqual([
      expect.objectContaining({
        selectedOptions: [
          expect.objectContaining({
            dimension: "printing",
            providerValue: "Confetti Galaxy Foil",
            unknownOptionPolicy: "leave-unmapped-review-evidence",
            previewDisposition: "review-evidence-if-catalog-option-unknown",
          }),
        ],
      }),
    ]);
    expect(preview.selectedOptions).toEqual([
      expect.objectContaining({
        dimension: "printing",
        providerValue: "Confetti Galaxy Foil",
        previewDisposition: "review-evidence-if-catalog-option-unknown",
      }),
    ]);
  });

  it("resolves selected option previews against active Catalog option schema", () => {
    const preview = externalReferencePreview(
      {
        extractionRules: {},
        contracts: [
          {
            id: "product-reference",
            target: "product-reference",
            providerKey: "tcgplayer",
            externalKeyPrefix: "sku:",
            source: mappingExpression("sku", "external-reference", ["external-reference"]) as MappingExpressionValue,
            ambiguityPolicy: "review-evidence",
            selectedOptions: {
              missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
              dimensions: [
                {
                  id: "condition",
                  dimensionKey: "condition",
                  providerValue: mappingExpression("condition", "external-reference", [
                    "selected-option",
                  ]) as MappingExpressionValue,
                  optionLookupTableKey: "catalog-condition",
                  required: true,
                },
                {
                  id: "printing",
                  dimensionKey: "printing",
                  providerValue: mappingExpression("printing", "external-reference", [
                    "selected-option",
                  ]) as MappingExpressionValue,
                  optionLookupTableKey: "catalog-printing",
                  required: true,
                },
              ],
            },
          },
        ],
        selectedOptionMapping: null,
      },
      { sku: 610001, condition: "Near Mint", printing: "Confetti Galaxy Foil" },
      {
        dimensions: [
          {
            dimensionId: "dim_condition",
            dimensionKey: "condition",
            dimensionName: "Condition",
            status: "active",
            options: [
              {
                optionId: "opt_near_mint",
                optionKey: "near-mint",
                optionLabel: "Near Mint",
                status: "active",
              },
            ],
          },
          {
            dimensionId: "dim_printing",
            dimensionKey: "printing",
            dimensionName: "Printing",
            status: "active",
            options: [],
          },
        ],
      },
    );

    expect(preview.selectedOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "condition", previewDisposition: "catalog-option-active" }),
        expect.objectContaining({ dimension: "printing", previewDisposition: "catalog-option-missing" }),
      ]),
    );
  });

  it("builds reference hierarchy previews from fixture payloads", () => {
    const preview = referenceHierarchyPreview(
      {
        rawMapping: {},
        providerReferenceIdPrefix: "ref_tcgdex",
        targetRecordRuleKey: "expansion",
        providerAttributes: [
          { id: "series-attribute", typeKey: "series", providerAttributeKey: "tcgdex-series-id" },
          { id: "expansion-attribute", typeKey: "expansion", providerAttributeKey: "tcgdex-set-id" },
        ],
        referenceTypes: [],
        recordRules: [
          {
            id: "series-rule",
            ruleKey: "series",
            typeKey: "series",
            recordIdKind: "provider",
            staticReferenceRecordId: "",
            providerRecordTypeKey: "series",
            providerValuePathsText: "seriesId, seriesName",
            keyRule: referencePathValueRule("seriesName"),
            nameRule: referencePathValueRule("seriesName"),
            descriptionRule: referenceTemplateValueRule(
              "{seriesName} Pokemon TCG series.",
              "seriesName=path:seriesName",
            ),
            attributes: [
              {
                id: "series-id-attribute",
                attributeKey: "tcgdex-series-id",
                valueRule: referencePathValueRule("seriesId"),
                optional: true,
              },
            ],
            requiredPathsText: "seriesName",
            relationshipsText: "part-of=product-line",
          },
          {
            id: "expansion-rule",
            ruleKey: "expansion",
            typeKey: "expansion",
            recordIdKind: "provider",
            staticReferenceRecordId: "",
            providerRecordTypeKey: "expansion",
            providerValuePathsText: "expansionId",
            keyRule: referencePathValueRule("expansionName"),
            nameRule: referencePathValueRule("expansionName"),
            descriptionRule: referenceTemplateValueRule(
              "{expansionName} Pokemon TCG expansion.",
              "expansionName=path:expansionName",
            ),
            attributes: [
              {
                id: "expansion-id-attribute",
                attributeKey: "tcgdex-set-id",
                valueRule: referencePathValueRule("expansionId"),
                optional: true,
              },
            ],
            requiredPathsText: "expansionName",
            relationshipsText: "part-of=series",
          },
        ],
        contracts: [
          {
            id: "expansion-contract",
            targetTypeKey: "expansion",
            providerAttributeKey: "tcgdex-set-id",
            referenceRecordKey: mappingExpression("expansionId", "external-reference", [
              "reference-hierarchy",
            ]) as MappingExpressionValue,
            parents: [
              {
                id: "series-parent",
                targetTypeKey: "series",
                providerAttributeKey: "tcgdex-series-id",
                referenceRecordKey: mappingExpression("seriesId", "external-reference", [
                  "reference-hierarchy",
                ]) as MappingExpressionValue,
              },
              {
                id: "product-line-parent",
                targetTypeKey: "product-line",
                providerAttributeKey: "official-name",
                referenceRecordKey: {
                  selector: { kind: "constant", value: "Pokemon Trading Card Game" },
                  owner: "catalog-truth",
                  uses: ["reference-hierarchy"],
                  redaction: "none",
                } as MappingExpressionValue,
              },
            ],
          },
        ],
      },
      {
        expansionId: "swsh3",
        expansionName: "Darkness Ablaze",
        seriesId: "swsh",
        seriesName: "Sword & Shield",
      },
    );

    expect(preview).toEqual([
      expect.objectContaining({
        typeKey: "expansion",
        providerAttributeKey: "tcgdex-set-id",
        referenceRecordKey: "swsh3",
        deterministicId: "ref_tcgdex_expansion_swsh3",
        parentChain: [
          expect.objectContaining({
            typeKey: "series",
            referenceRecordKey: "swsh",
            deterministicId: "ref_tcgdex_series_swsh",
          }),
          expect.objectContaining({
            typeKey: "product-line",
            referenceRecordKey: "Pokemon Trading Card Game",
            deterministicId: "ref_tcgdex_product-line_pokemon_trading_card_game",
          }),
        ],
      }),
    ]);
  });

  it("builds duplicate-prevention fixture previews for each rule kind", () => {
    const preview = duplicatePreventionPreview(
      {
        rawMapping: {},
        rawAmbiguityRules: {},
        exactExternalCatalogItemReferencesFirst: true,
        ambiguousCandidatePolicy: "block-promotion",
        replayPolicy: "same-profile-version",
        mergeCandidateEvidence: [
          {
            id: "merge-name",
            expression: mappingExpression("normalized.name", "catalog-truth", [
              "merge-identity",
            ]) as MappingExpressionValue,
          },
        ],
        identityRules: [
          duplicatePreviewRule(
            "exact-external",
            "exact-external-catalog-item-reference",
            "externalCatalogItemReferences.0.externalKey",
          ),
          duplicatePreviewRule("observation-link", "source-observation-link", "externalKey"),
          duplicatePreviewRule("deterministic-fields", "deterministic-field-match", "normalized.cardNumber"),
          duplicatePreviewRule("sealed-product", "sealed-product-match", "normalized.productName"),
          duplicatePreviewRule("barcode", "barcode-gtin-match", "normalized.barcode"),
          duplicatePreviewRule("bridge", "future-provider-bridge-match", "providerBridgeKey"),
        ],
      },
      {
        externalKey: "tcgplayer:sku:610001",
        externalCatalogItemReferences: [{ externalKey: "product:14240" }],
        providerBridgeKey: "bridge:tcgplayer:14240",
        normalized: {
          name: "Charizard ex",
          cardNumber: "223",
          productName: "Prismatic Evolutions Elite Trainer Box",
          barcode: "0082064551238",
        },
      },
    );

    expect(preview.policy).toMatchObject({
      ambiguousCandidatePolicy: "block-promotion",
      exactExternalCatalogItemReferencesFirst: true,
    });
    expect(preview.mergeCandidateEvidence).toEqual(["Charizard ex"]);
    expect(preview.identityRules.map((rule) => rule.ruleKind)).toEqual([
      "exact-external-catalog-item-reference",
      "source-observation-link",
      "deterministic-field-match",
      "sealed-product-match",
      "barcode-gtin-match",
      "future-provider-bridge-match",
    ]);
    expect(preview.identityRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleKey: "barcode", evidence: ["0082064551238"] }),
        expect.objectContaining({
          ruleKey: "bridge",
          evidence: ["bridge:tcgplayer:14240"],
          ambiguousOutcome: "blocks-ambiguous-candidates",
        }),
      ]),
    );
  });

  it("builds ordered promotion command previews from fixture payloads", () => {
    const preview = promotionPlanPreview(
      {
        planKind: "catalog-item-promotion",
        requiresReview: true,
        commands: [
          promotionPreviewCommand("CreateCatalogItem", {
            title: "card.name",
            externalKey: "externalKey",
          }),
          promotionPreviewCommand("AssignBlueprintToCatalogItem", {
            blueprintKey: "catalog.blueprintKey",
          }),
          promotionPreviewCommand("SetCatalogItemFieldValue", {
            fieldKey: "catalog.fields.cardName",
            value: "card.name",
          }),
        ],
      },
      {
        externalKey: "tcgdex:swsh3-20",
        card: { name: "Charizard", localId: "20" },
        catalog: {
          blueprintKey: "pokemon-card-single",
          fields: { cardName: "card-name" },
        },
      },
    );

    expect(preview).toEqual({
      planKind: "catalog-item-promotion",
      requiresReview: true,
      commands: [
        {
          order: 1,
          commandName: "CreateCatalogItem",
          requiredInputs: ["title"],
          inputs: { title: "Charizard", externalKey: "tcgdex:swsh3-20" },
          resolvedTargets: [],
        },
        {
          order: 2,
          commandName: "AssignBlueprintToCatalogItem",
          requiredInputs: ["blueprintKey"],
          inputs: { blueprintKey: "pokemon-card-single" },
          resolvedTargets: [],
        },
        {
          order: 3,
          commandName: "SetCatalogItemFieldValue",
          requiredInputs: ["fieldKey", "value"],
          inputs: { fieldKey: "card-name", value: "Charizard" },
          resolvedTargets: [],
        },
      ],
      resolvedTargets: [],
    });
    expect(promotionCommandRequiredInputKeys("LinkExternalProductReference")).toEqual(["providerKey", "externalKey"]);
  });

  it("resolves promotion command fixture inputs to Catalog target records", () => {
    const preview = promotionPlanPreview(
      {
        planKind: "catalog-item-promotion",
        requiresReview: true,
        commands: [
          promotionPreviewCommand("AssignBlueprintToCatalogItem", {
            blueprintKey: "catalog.blueprintKey",
          }),
          promotionPreviewCommand("AssignCatalogItemToCategory", {
            categoryKey: "catalog.categoryKey",
          }),
          promotionPreviewCommand("SetCatalogItemFieldValue", {
            fieldKey: "catalog.fields.cardName",
            value: "card.name",
          }),
        ],
      },
      {
        card: { name: "Charizard" },
        catalog: {
          blueprintKey: "pokemon-card-single",
          categoryKey: "trading-card-singles",
          fields: { cardName: "card-name" },
        },
      },
      {
        blueprints: [{ id: "bp_pokemon", key: "pokemon-card-single", name: "Pokemon Card", status: "active" }],
        categories: [{ id: "cat_singles", key: "trading-card-singles", name: "Singles", status: "active" }],
        fields: [{ id: "fld_name", key: "card-name", name: "Card Name", status: "active" }],
      },
    );

    expect(preview.resolvedTargets).toEqual([
      expect.objectContaining({
        inputKey: "blueprintKey",
        targetKind: "blueprint",
        targetId: "bp_pokemon",
        disposition: "catalog-target-active",
      }),
      expect.objectContaining({
        inputKey: "categoryKey",
        targetKind: "category",
        targetId: "cat_singles",
        disposition: "catalog-target-active",
      }),
      expect.objectContaining({
        inputKey: "fieldKey",
        targetKind: "field",
        targetId: "fld_name",
        disposition: "catalog-target-active",
      }),
    ]);
  });
});

function mappingExpression(
  path: string,
  owner:
    | "catalog-truth"
    | "catalog-merge-evidence"
    | "external-reference"
    | "pricing-signal"
    | "inventory-signal"
    | "operations"
    | "excluded",
  uses: readonly (
    | "source-payload"
    | "normalized-observation"
    | "hash-material"
    | "merge-identity"
    | "external-reference"
    | "selected-option"
    | "reference-hierarchy"
    | "promotion-command"
  )[],
  options: Partial<{ redaction: "none" | "secret" | "seller" | "price" | "operations"; required: boolean }> = {},
) {
  return {
    selector: {
      kind: "path",
      path,
      required: options.required ?? true,
      nullPolicy: "diagnostic",
    },
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function referencePathValueRule(path: string) {
  return {
    kind: "path" as const,
    staticValue: "",
    path,
    template: "",
    templateValuesText: "",
  };
}

function referenceTemplateValueRule(template: string, templateValuesText: string) {
  return {
    kind: "template" as const,
    staticValue: "",
    path: "",
    template,
    templateValuesText,
  };
}

function duplicatePreviewRule(
  ruleKey: string,
  ruleKind:
    | "exact-external-catalog-item-reference"
    | "source-observation-link"
    | "deterministic-field-match"
    | "sealed-product-match"
    | "barcode-gtin-match"
    | "future-provider-bridge-match",
  path: string,
) {
  return {
    id: `duplicate-${ruleKey}`,
    ruleKey,
    ruleKind,
    candidatePolicy: "reuse" as const,
    evidence: [
      {
        id: `${ruleKey}-evidence`,
        expression: mappingExpression(path, "catalog-merge-evidence", ["merge-identity"]) as MappingExpressionValue,
      },
    ],
  };
}

function promotionPreviewCommand(
  commandName:
    | "CreateCatalogItem"
    | "RefreshCatalogItem"
    | "ReviseCatalogItemMetadata"
    | "AssignBlueprintToCatalogItem"
    | "AssignCatalogItemToCategory"
    | "SetCatalogItemFieldValue"
    | "SetCatalogItemTags"
    | "SetCatalogItemImageUrls"
    | "SetCatalogItemProductAssetSets"
    | "LinkExternalCatalogItemReference"
    | "LinkExternalProductReference",
  inputs: Record<string, string>,
) {
  return {
    id: `promotion-${commandName}`,
    unsupportedCommandName: null,
    commandName,
    inputs: Object.entries(inputs).map(([fieldKey, path]) => ({
      id: `promotion-${commandName}-${fieldKey}`,
      fieldKey,
      expression: mappingExpression(path, "catalog-truth", ["promotion-command"]) as MappingExpressionValue,
    })),
  };
}
