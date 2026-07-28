import { describe, expect, it } from "vitest";
import {
  evaluateCatalogProviderMappingExpression,
  validateCatalogProviderMappingExpressionsAgainstFixtures,
  type CatalogProviderMappingInterpreterOptions,
} from "./provider-mapping-interpreter";
import type {
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingRuntimeFunctionKey,
  CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";

describe("provider mapping selector and transform interpreter", () => {
  const payload = {
    product: {
      productId: 12345,
      name: "  Charizard ex  ",
      set: {
        name: "Obsidian Flames",
      },
      flags: {
        sealed: "false",
      },
      prices: {
        market: "19.99",
      },
      skus: [
        { skuId: 1, condition: "Near Mint", language: "English" },
        { skuId: 2, condition: "Lightly Played", language: "English" },
      ],
    },
  } as const;

  it("reads nested paths and applies string and coercion transforms", () => {
    const result = evaluateCatalogProviderMappingExpression(
      expr("product.name", {
        transforms: [
          { kind: "string", operation: "trim" },
          { kind: "string", operation: "lowercase" },
        ],
      }),
      payload,
    );
    const productId = evaluateCatalogProviderMappingExpression(
      expr("product.productId", { transforms: [{ kind: "coerce", to: "string" }] }),
      payload,
    );
    const sealed = evaluateCatalogProviderMappingExpression(
      expr("product.flags.sealed", { transforms: [{ kind: "coerce", to: "boolean" }] }),
      payload,
    );

    expect(result).toMatchObject({ evidence: { value: "charizard ex" }, diagnostics: [] });
    expect(productId).toMatchObject({ evidence: { value: "12345" }, diagnostics: [] });
    expect(sealed).toMatchObject({ evidence: { value: false }, diagnostics: [] });
  });

  it("supports constants and fallback coalesce selectors without logging missing source values", () => {
    const result = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression(),
        selector: {
          kind: "coalesce",
          required: true,
          selectors: [
            { kind: "path", path: "product.missingName", required: true, nullPolicy: "diagnostic" },
            { kind: "path", path: "product.set.name", required: true, nullPolicy: "diagnostic" },
            { kind: "constant", value: "unknown" },
          ],
        },
      },
      payload,
    );

    expect(result).toMatchObject({ evidence: { value: "Obsidian Flames" }, diagnostics: [] });
  });

  it("maps arrays into provider evidence objects", () => {
    const result = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression(),
        selector: {
          kind: "array-map",
          path: "product.skus",
          emptyPolicy: "diagnostic",
          item: {
            ...baseExpression({ owner: "catalog-merge-evidence", uses: ["selected-option"] }),
            selector: {
              kind: "object",
              fields: {
                sku: expr("skuId", { transforms: [{ kind: "coerce", to: "string" }] }),
                condition: expr("condition", {
                  transforms: [
                    { kind: "string", operation: "normalize-provider-option" },
                    { kind: "lookup", tableKey: "condition-aliases", unknownPolicy: "diagnostic" },
                  ],
                }),
              },
            },
          },
        },
      },
      payload,
      {
        lookupTables: {
          "condition-aliases": {
            "near-mint": "near-mint",
            "lightly-played": "lightly-played",
          },
        },
      },
    );

    expect(result).toMatchObject({
      evidence: {
        value: [
          { sku: "1", condition: "near-mint" },
          { sku: "2", condition: "lightly-played" },
        ],
      },
      diagnostics: [],
    });
  });

  it("builds templated strings and arrays from provider evidence", () => {
    const result = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression({ owner: "external-reference", uses: ["external-reference"] }),
        selector: {
          kind: "array",
          items: [
            {
              ...baseExpression({ owner: "external-reference", uses: ["external-reference"] }),
              selector: {
                kind: "object",
                fields: {
                  providerKey: {
                    ...baseExpression({ owner: "external-reference", uses: ["external-reference"] }),
                    selector: { kind: "constant", value: "tcgplayer" },
                  },
                  externalKey: {
                    ...baseExpression({ owner: "external-reference", uses: ["external-reference"] }),
                    selector: {
                      kind: "template",
                      template: "product:{productId}",
                      required: true,
                      values: {
                        productId: expr("product.productId", { transforms: [{ kind: "coerce", to: "string" }] }),
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      payload,
    );

    expect(result).toMatchObject({
      evidence: {
        value: [{ providerKey: "tcgplayer", externalKey: "product:12345" }],
      },
      diagnostics: [],
    });
  });

  it("applies named selectors and transforms only when a registry explicitly provides them", () => {
    const options: CatalogProviderMappingInterpreterOptions = {
      namedSelectors: {
        "scrydex-tcgplayer-id-reference-extractor": ({ rootPayload }) =>
          typeof rootPayload === "object" && rootPayload !== null && !Array.isArray(rootPayload)
            ? ((rootPayload as { product?: { productId?: number } }).product?.productId ?? null)
            : null,
      },
      namedTransforms: {
        "scrydex-tcgplayer-id-reference-extractor": ({ value }) => `product:${String(value)}`,
      },
    };

    const result = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression(),
        selector: {
          kind: "named-runtime-selector",
          functionKey: "scrydex-tcgplayer-id-reference-extractor",
          reason: "Fixture-only extraction hook.",
        },
        transforms: [
          {
            kind: "named-transform",
            functionKey: "scrydex-tcgplayer-id-reference-extractor",
            reason: "Fixture-only formatting hook.",
          },
        ],
      },
      payload,
      options,
    );
    const missing = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression({ redaction: "secret" }),
        selector: {
          kind: "named-runtime-selector",
          functionKey: "tcgdex-card-variant-expander",
          reason: "Not registered in this test.",
        },
      },
      payload,
    );

    expect(result).toMatchObject({ evidence: { value: "product:12345" }, diagnostics: [] });
    expect(missing.diagnostics).toEqual([
      expect.objectContaining({
        code: "unregistered-named-selector",
        path: "expression.selector.functionKey",
        redaction: "secret",
      }),
    ]);
    expect(JSON.stringify(missing.diagnostics)).not.toContain("Charizard");
  });

  it("honors null and omit policies", () => {
    const nullable = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression(),
        selector: { kind: "path", path: "product.unknown", required: false, nullPolicy: "omit" },
      },
      payload,
    );
    const diagnostic = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression({ redaction: "seller" }),
        selector: { kind: "path", path: "product.unknown", required: true, nullPolicy: "diagnostic" },
      },
      payload,
    );

    expect(nullable).toMatchObject({ evidence: null, omitted: true, diagnostics: [] });
    expect(diagnostic.diagnostics).toEqual([
      expect.objectContaining({
        code: "missing-required-path",
        redaction: "seller",
        diagnosticText: "Required provider field 'product.unknown' was not present.",
      }),
    ]);
  });

  it("uses lookup unknown policies for diagnostics, omission, or review evidence", () => {
    const missingLookup = expr("product.skus[0].language", {
      transforms: [{ kind: "lookup", tableKey: "language-aliases", unknownPolicy: "review-evidence" }],
    });
    const omittedLookup = expr("product.skus[0].language", {
      transforms: [{ kind: "lookup", tableKey: "language-aliases", unknownPolicy: "omit" }],
    });

    expect(evaluateCatalogProviderMappingExpression(missingLookup, payload)).toMatchObject({
      evidence: { value: "English" },
      diagnostics: [expect.objectContaining({ code: "lookup-miss" })],
    });
    expect(evaluateCatalogProviderMappingExpression(omittedLookup, payload)).toMatchObject({
      evidence: null,
      omitted: true,
      diagnostics: [],
    });
  });

  it("validates configs against fixtures before imports run", () => {
    const diagnostics = validateCatalogProviderMappingExpressionsAgainstFixtures(
      {
        requiredName: expr("product.name"),
        missingPriceNumber: expr("product.prices.market", {
          redaction: "price",
          transforms: [{ kind: "coerce", to: "number" }],
        }),
        badNamedTransform: expr("product.name", {
          transforms: [
            {
              kind: "named-transform",
              functionKey: "tcgplayer-sku-selected-option-resolver",
              reason: "Must be registered by the caller.",
            },
          ],
        }),
      },
      [
        {
          product: {
            name: "Fixture",
            prices: {
              market: "not-a-number",
            },
          },
        },
      ],
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "coerce-failed",
          path: "fixtures.0.missingPriceNumber.transforms.0",
          redaction: "price",
        }),
        expect.objectContaining({
          code: "unregistered-named-transform",
          path: "fixtures.0.badNamedTransform.transforms.0.functionKey",
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("not-a-number");
  });

  it("reports invalid array configs without provider-specific branches", () => {
    const result = evaluateCatalogProviderMappingExpression(
      {
        ...baseExpression(),
        selector: {
          kind: "array-map",
          path: "product.name",
          emptyPolicy: "diagnostic",
          item: expr("skuId"),
        },
      },
      payload,
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "expected-array",
        path: "expression.selector.path",
      }),
    ]);
  });
});

function expr(
  path: string,
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    ...baseExpression({ redaction: options.redaction }),
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    transforms: options.transforms,
  };
}

function baseExpression(
  options: Partial<{
    owner: CatalogProviderMappingEvidenceOwner;
    uses: readonly CatalogProviderMappingEvidenceUse[];
    redaction: CatalogProviderMappingValueExpression["redaction"];
  }> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: { kind: "constant", value: null },
    owner: options.owner ?? "catalog-merge-evidence",
    uses: options.uses ?? ["source-payload"],
    redaction: options.redaction ?? "none",
  };
}
