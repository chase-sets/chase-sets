import { describe, expect, it } from "vitest";
import {
  findKeySetTripwireViolations,
  keySetFingerprint,
  updateKeySetBaselines,
} from "./catalog-localization-keyset-tripwire.mjs";

const catalogTestPath = "contracts/localization/catalog-key-set.test.ts";
const catalogMapPath = "contracts/localization/locales/en/catalog.ts";
const catalogLeafPath = "contracts/localization/locales/en/catalog/source-observations.ts";

function fixtureFiles(keys) {
  const fingerprint = keySetFingerprint(keys);
  return {
    [catalogTestPath]: `import { createHash } from "node:crypto";\nimport { catalogEnglishTranslations } from "./locales/en/catalog";\nconst englishCatalogKeySet = {\n  count: ${fingerprint.count},\n  sha256: "${fingerprint.sha256}",\n} as const;\nexpect(keySetFingerprint(Object.keys(catalogEnglishTranslations))).toEqual(englishCatalogKeySet);\n`,
    [catalogMapPath]: `import { sourceObservationTranslations } from "./catalog/source-observations";\nexport const catalogEnglishTranslations = { ...sourceObservationTranslations };\n`,
    [catalogLeafPath]: keys.map((key) => `  "${key}": "${key}",`).join("\n"),
  };
}

describe("catalog localization key-set tripwire", () => {
  it("fails the negative control when a real catalog translation artifact loses a key without a rebaseline", () => {
    const baseFiles = fixtureFiles(["catalog.alpha", "catalog.removed"]);
    const currentFiles = fixtureFiles(["catalog.alpha"]);
    currentFiles[catalogTestPath] = baseFiles[catalogTestPath];

    const violations = findKeySetTripwireViolations({ baseFiles, currentFiles });

    expect(violations).toHaveLength(1);
    expect(violations[0].testPath).toBe(catalogTestPath);
    expect(violations[0].sourceRoot).toBe(catalogMapPath);
    expect(violations[0].message).toContain("--write-baseline");
  });

  it("passes the negative control after the full fingerprint regeneration", () => {
    const baseFiles = fixtureFiles(["catalog.alpha", "catalog.removed"]);
    const currentFiles = updateKeySetBaselines(fixtureFiles(["catalog.alpha"]));

    expect(findKeySetTripwireViolations({ baseFiles, currentFiles })).toEqual([]);
  });
});
