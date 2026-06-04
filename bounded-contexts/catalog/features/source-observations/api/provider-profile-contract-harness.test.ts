import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import {
  formatCatalogProviderProfileFixtureFailures,
  validateCatalogProviderProfileFixtures,
} from "./provider-profile-contract-harness";
import { catalogProviderProfileFixtureCases } from "./provider-profile-fixture-cases";
import { dryRunCatalogProviderProfileVersion } from "./provider-profile-review";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";

describe("Catalog provider profile contract harness", () => {
  it("validates every executable profile against local golden fixtures without provider calls", async () => {
    const results = await validateCatalogProviderProfileFixtures({
      versions: catalogProviderIntegrationProfileVersions,
      fixtureCases: catalogProviderProfileFixtureCases(),
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

async function dryRunFixture(providerKey: string, flow: "normal" | "changed" | "replay") {
  const fixtureCase = catalogProviderProfileFixtureCases().find(
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
    countProfileVersionReferences: async () => 0,
  };
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}
