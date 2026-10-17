import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  consumedEmbeddedThemeCssInputs,
  embeddedAppearanceSourceDigests,
  embeddedThemeSourcePath,
  parseEmbeddedThemeCssInputs,
} from "../../deployables/marketplace/e2e/support/stripe-appearance-evidence-source.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const source = readFileSync(join(root, embeddedThemeSourcePath), "utf8");
const predecessorSource = execFileSync(
  "git",
  ["show", "be97a105ae14a39571d5231c52b3883dcaeffb92:packages/design-system/src/theme/stripe-appearance.ts"],
  { cwd: root, encoding: "utf8" },
);
const predecessorInputs = new Set(
  [...predecessorSource.matchAll(/(?:pxToken|token)\("(--[\w-]+)"/g)].map((match) => match[1]),
);
const predecessorSnapshot = predecessorSource.match(/const appearanceSnapshotTokens = \[([\s\S]*?)\] as const;/)?.[1];
if (!predecessorSnapshot) throw new Error("Predecessor snapshot seam missing");
for (const match of predecessorSnapshot.matchAll(/"(--[\w-]+)"/g)) predecessorInputs.add(match[1]);
const specs = [
  "deployables/marketplace/e2e/account-payment-stripe-embed.uat.spec.ts",
  "deployables/marketplace/e2e/payout-connect-appearance.uat.spec.ts",
];
const shared = [
  "contracts/embedded-surface-theme/index.ts",
  embeddedThemeSourcePath,
  "packages/design-system/src/theme/internal-token-values.ts",
  "infrastructure/stripe-appearance/stripe-appearance.ts",
  "packages/design-system/src/theme/__fixtures__/ink-foil-candidate-tokens.json",
  "deployables/marketplace/e2e/support/stripe-appearance-evidence-source.ts",
  "playwright.stripe-appearance-evidence.config.ts",
];

describe("both actual appearance evidence helpers", () => {
  it("derives the same 34 CSS inputs from the one literal authority in both specs", () => {
    const expected = consumedEmbeddedThemeCssInputs(root);
    expect(expected).toHaveLength(34);
    expect(expected).toEqual([...predecessorInputs].sort());
    expect(new Set(expected).size).toBe(34);
    for (const spec of specs) {
      const text = readFileSync(join(root, spec), "utf8");
      expect(text).toContain("consumedEmbeddedThemeCssInputs(");
      expect(text).toContain("embeddedAppearanceSourceDigests(");
      expect(text).not.toContain("appearanceSnapshotTokens array not found");
      expect(consumedEmbeddedThemeCssInputs(root)).toEqual(expected);
      const digests = embeddedAppearanceSourceDigests(root, spec);
      expect(Object.keys(digests).sort()).toEqual([...shared, spec].sort());
      expect(Object.values(digests).every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
      for (const missing of shared)
        expect(
          Object.keys(digests)
            .filter((key) => key !== missing)
            .sort(),
        ).not.toEqual([...shared, spec].sort());
    }
  });

  it("refuses one omitted, nonliteral, or duplicate input", () => {
    expect(() => parseEmbeddedThemeCssInputs(source.replace('  pageBackground: "--background",', ""))).toThrow();
    expect(() =>
      parseEmbeddedThemeCssInputs(source.replace('pageBackground: "--background"', "pageBackground: dynamicName")),
    ).toThrow();
    expect(() => parseEmbeddedThemeCssInputs(source.replace('surface: "--card"', 'surface: "--background"'))).toThrow();
    expect(() =>
      parseEmbeddedThemeCssInputs(source.replace('surface: "--card"', 'pageBackground: "--card"')),
    ).toThrow();
  });

  it("is red against the unchanged predecessor's provider-specific source", () => {
    expect(() => parseEmbeddedThemeCssInputs(predecessorSource)).toThrow("Embedded theme input literal map missing");
  });
});
