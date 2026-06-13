import { describe, expect, it } from "vitest";
import { validateDirectoryIntentEntry } from "./run.mjs";

const manifest = {
  contextName: "catalog",
  ownedNouns: ["catalog-item"],
  slices: ["catalog-items"],
};

function validate(intent) {
  return validateDirectoryIntentEntry({
    manifest,
    relativeRoot: "bounded-contexts/catalog",
    directoryName: "catalog-items",
    intent,
  });
}

describe("directoryIntent schema validation", () => {
  it("accepts the slim load-bearing schema", () => {
    const diagnostics = validate({
      classification: "slice",
      purpose: "Own catalog-item feature behavior for the catalog context.",
      expectedConsumers: ["Internal catalog module composition"],
    });

    expect(diagnostics.violations).toEqual([]);
    expect(diagnostics.warnings).toEqual([]);
  });

  it("rejects retired ceremony prose fields", () => {
    const diagnostics = validate({
      classification: "slice",
      purpose: "Own catalog-item feature behavior for the catalog context.",
      expectedConsumers: ["Internal catalog module composition"],
      allowedWhen: "Always; slice directories are the default root shape for implemented context features.",
      createdFor: "catalog workflows that span multiple features or public entrypoints.",
      justification: "catalog-items centralizes context-local composition that should not duplicate across features.",
      sunsetWhen: "Remove when all consumers can move the behavior back into feature-local modules.",
    });

    expect(diagnostics.violations).toEqual([
      {
        path: "bounded-contexts/catalog/context.json directoryIntent.catalog-items.allowedWhen",
        message:
          "field is not part of the directoryIntent schema; allowed fields: classification, crossCuttingRuntimeComposition, expectedConsumers, purpose",
      },
      {
        path: "bounded-contexts/catalog/context.json directoryIntent.catalog-items.createdFor",
        message:
          "field is not part of the directoryIntent schema; allowed fields: classification, crossCuttingRuntimeComposition, expectedConsumers, purpose",
      },
      {
        path: "bounded-contexts/catalog/context.json directoryIntent.catalog-items.justification",
        message:
          "field is not part of the directoryIntent schema; allowed fields: classification, crossCuttingRuntimeComposition, expectedConsumers, purpose",
      },
      {
        path: "bounded-contexts/catalog/context.json directoryIntent.catalog-items.sunsetWhen",
        message:
          "field is not part of the directoryIntent schema; allowed fields: classification, crossCuttingRuntimeComposition, expectedConsumers, purpose",
      },
    ]);
    expect(diagnostics.warnings).toEqual([]);
  });
});
