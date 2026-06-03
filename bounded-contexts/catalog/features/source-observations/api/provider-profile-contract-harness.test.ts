import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { catalogProviderRequiredFixtureFlows } from "./provider-integration-mapping-contract";
import {
  formatCatalogProviderProfileFixtureFailures,
  validateCatalogProviderProfileFixtures,
  type CatalogProviderProfileFixtureCase,
} from "./provider-profile-contract-harness";
import { dryRunCatalogProviderProfileVersion } from "./provider-profile-review";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";

describe("Catalog provider profile contract harness", () => {
  it("validates every executable profile against local golden fixtures without provider calls", async () => {
    const results = await validateCatalogProviderProfileFixtures({
      versions: catalogProviderIntegrationProfileVersions,
      fixtureCases: fixtureCases(),
      repositoryRoot: repositoryRoot(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(formatCatalogProviderProfileFixtureFailures(results)).toBe("");
    expect(results.map((result) => `${result.providerKey}@${result.profileVersion}`)).toEqual([
      "scrydex@2026.06.03",
      "tcgdex@2026.06.03",
      "tcgplayer@2026.06.03",
    ]);
  });

  it("keeps replay deterministic while changed fixtures move the source hash", async () => {
    for (const providerKey of ["scrydex", "tcgdex", "tcgplayer"]) {
      const normal = await dryRunFixture(providerKey, "normal");
      const replay = await dryRunFixture(providerKey, "replay");
      const changed = await dryRunFixture(providerKey, "changed");

      expect(normal.observation?.sourceRecordHash, providerKey).toBe(replay.observation?.sourceRecordHash);
      expect(normal.observation?.sourceRecordHash, providerKey).not.toBe(changed.observation?.sourceRecordHash);
      expect(normal.observation?.sourceMappingFingerprint, providerKey).toBe(
        replay.observation?.sourceMappingFingerprint,
      );
    }
  });

  it("guards Catalog truth from pricing, inventory, seller, and secret evidence", () => {
    for (const version of catalogProviderIntegrationProfileVersions) {
      const contract = version.executableMappingContract;
      expect(contract?.fixtures.liveProviderCallsAllowed, version.providerKey).toBe(false);
      expect(contract?.nonGoals, version.providerKey).toEqual(
        expect.arrayContaining([
          "no-live-provider-calls-in-mapping-tests",
          "no-pricing-facts-as-catalog-truth",
          "no-inventory-facts-as-global-catalog-truth",
          "no-provider-secrets-in-events-logs-or-fixtures",
        ]),
      );
      expect(JSON.stringify(contract), version.providerKey).not.toMatch(
        /"owner":"pricing-signal".*"uses":\["(?:normalized-observation|hash-material|merge-identity|external-reference|selected-option|reference-hierarchy|promotion-command)"/,
      );
      expect(JSON.stringify(contract), version.providerKey).not.toMatch(
        /"owner":"inventory-signal".*"uses":\["(?:normalized-observation|hash-material|merge-identity|external-reference|selected-option|reference-hierarchy|promotion-command)"/,
      );
    }
  });
});

function fixtureCases(): readonly CatalogProviderProfileFixtureCase[] {
  return [
    ...providerCases("scrydex", {
      normal: {
        expectedObservation: {
          externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
          normalizedKind: "provider-product",
          normalizedFields: {
            name: "Fury Sliver",
            productLineName: "Magic: The Gathering",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        },
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: [
          "duplicatePrevention.mergeCandidateEvidence.0",
          "duplicatePrevention.mergeCandidateEvidence.1",
          "duplicatePrevention.mergeCandidateEvidence.2",
        ],
      },
      "sealed-product": {
        expectedObservation: {
          externalKey: "scryfall:sealed-fixture-0001",
          normalizedKind: "provider-product",
          normalizedFields: {
            name: "Time Spiral Booster Pack",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
        },
      },
      "unknown-option": {
        expectedObservation: {
          externalKey: "scryfall:unknown-option-fixture-0001",
          normalizedKind: "provider-product",
          normalizedFields: {
            cardNumber: "001-star",
          },
        },
      },
    }),
    ...providerCases("tcgdex", {
      normal: {
        expectedObservation: {
          externalKey: "en:sv01-001",
          normalizedKind: "pokemon-card",
          normalizedFields: {
            name: "Sprigatito",
            cardNumber: "001",
            cardVariantKey: "standard",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:493958" }],
        },
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: [
          "duplicatePrevention.mergeCandidateEvidence.0",
          "duplicatePrevention.mergeCandidateEvidence.1",
        ],
        expectedPromotionCommands: [
          "CreateCatalogItem",
          "AssignBlueprintToCatalogItem",
          "SetCatalogItemFieldValue",
          "AssignCatalogItemToCategory",
          "LinkExternalCatalogItemReference",
        ],
      },
      "sealed-product": {
        expectedObservation: {
          externalKey: "en:sv01-etb-sealed",
          normalizedKind: "pokemon-card",
          normalizedFields: {
            category: "Sealed",
            cardVariantKey: "sealed",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
        },
      },
      "unknown-option": {
        expectedObservation: {
          externalKey: "en:sv01-001-unknown-option",
          normalizedKind: "pokemon-card",
          normalizedFields: {
            cardVariantKey: "provider-new-foil",
          },
        },
      },
    }),
    ...providerCases("tcgplayer", {
      normal: {
        expectedObservation: {
          externalKey: "493958",
          normalizedKind: "provider-product",
          normalizedFields: {
            name: "Sprigatito",
            productForm: "single",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:493958" }],
          externalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:15500001",
              selectedOptions: [
                { dimensionKey: "condition", optionKey: "near-mint", providerValue: "Near Mint" },
                { dimensionKey: "printing", optionKey: "normal", providerValue: "Normal" },
                { dimensionKey: "language", optionKey: "en", providerValue: "English" },
              ],
            },
          ],
        },
        expectedHashEvidencePaths: ["normalizedObservation.hashMaterial.0"],
        expectedMergeEvidencePaths: [
          "duplicatePrevention.mergeCandidateEvidence.0",
          "duplicatePrevention.mergeCandidateEvidence.1",
          "duplicatePrevention.mergeCandidateEvidence.2",
        ],
      },
      "sealed-product": {
        expectedObservation: {
          externalKey: "497105",
          normalizedKind: "provider-product",
          normalizedFields: {
            productForm: "sealed",
            name: "Scarlet & Violet Elite Trainer Box",
          },
          externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
          externalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:15501001",
              selectedOptions: [{ dimensionKey: "product-form", optionKey: "sealed", providerValue: "Sealed" }],
            },
          ],
        },
      },
      "unknown-option": {
        expectedObservation: {
          externalKey: "493958-unknown-option",
          normalizedKind: "provider-product",
          externalProductReferences: [
            {
              providerKey: "tcgplayer",
              externalKey: "sku:15500003",
              selectedOptions: [{ dimensionKey: "printing", optionKey: null, providerValue: "Confetti Galaxy Foil" }],
            },
          ],
        },
      },
    }),
  ];
}

function providerCases(
  providerKey: string,
  expectations: Partial<Record<string, Partial<CatalogProviderProfileFixtureCase>>>,
): readonly CatalogProviderProfileFixtureCase[] {
  return catalogProviderRequiredFixtureFlows.map((flow) => ({
    providerKey,
    profileVersion: "2026.06.03",
    flow,
    payloadFile: `${flow}.json`,
    expectedStatus: "completed",
    expectedObservation: { normalizedKind: providerKey === "tcgdex" ? "pokemon-card" : "provider-product" },
    ...expectations[flow],
  }));
}

async function dryRunFixture(providerKey: string, flow: "normal" | "changed" | "replay") {
  const fixtureCase = fixtureCases().find(
    (candidate) => candidate.providerKey === providerKey && candidate.flow === flow,
  );
  if (!fixtureCase) {
    throw new Error(`Missing fixture case for ${providerKey}:${flow}.`);
  }
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === providerKey);
  if (!version) {
    throw new Error(`Missing profile version for ${providerKey}.`);
  }
  const payload = JSON.parse(
    await readFile(path.join(repositoryRoot(), version.fixtures.fixtureRoot, fixtureCase.payloadFile), "utf8"),
  ) as JsonValue;

  return dryRunCatalogProviderProfileVersion({
    store: profileStore(catalogProviderIntegrationProfileVersions),
    providerKey,
    profileVersion: fixtureCase.profileVersion,
    payload,
    observedAt: "2026-06-03T00:00:00.000Z",
  });
}

function profileStore(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): CatalogProviderIntegrationProfileVersionStore {
  return {
    seedProfileVersions: async () => versions,
    upsertProfileVersion: async (version) => version,
    listProfileVersions: async (providerKey) =>
      versions.filter((version) => !providerKey || version.providerKey === providerKey),
    getProfileVersion: async (providerKey, profileVersion) =>
      versions.find((version) => version.providerKey === providerKey && version.profileVersion === profileVersion) ??
      null,
    getActiveProfileVersion: async (providerKey) =>
      versions.find((version) => version.providerKey === providerKey && version.active) ?? null,
    activateProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      return { ...version, lifecycle: "active", active: true };
    },
    deprecateProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      return { ...version, lifecycle: "deprecated", active: false };
    },
    rollbackProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) => candidate.providerKey === providerKey && candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error("Profile version not found.");
      }
      return { ...version, lifecycle: "active", active: true };
    },
  };
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}
