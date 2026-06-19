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
      "mtgjson@2026.06.19",
      "mtgjson@2026.06.19",
      "scryfall@2026.06.19",
      "scryfall@2026.06.19",
      "tcgdex@2026.06.03",
      "tcgplayer@2026.06.03",
    ]);
  });

  it("keeps replay deterministic while changed fixtures move the source hash", async () => {
    const identities = [
      { providerKey: "mtgjson", profileKey: "mtg-card-reference-data", profileVersion: "2026.06.19" },
      { providerKey: "mtgjson", profileKey: "mtg-set-reference-data", profileVersion: "2026.06.19" },
      { providerKey: "scryfall", profileKey: "mtg-card-print-reference-data", profileVersion: "2026.06.19" },
      { providerKey: "scryfall", profileKey: "mtg-card-image-evidence", profileVersion: "2026.06.19" },
      { providerKey: "tcgdex", profileVersion: "2026.06.03" },
      { providerKey: "tcgplayer", profileVersion: "2026.06.03" },
    ];
    const results = await Promise.all(
      identities.map(async (identity) => {
        const [normal, replay, changed] = await Promise.all([
          dryRunFixture(identity, "normal"),
          dryRunFixture(identity, "replay"),
          dryRunFixture(identity, "changed"),
        ]);
        return { providerKey: identity.profileKey ?? identity.providerKey, normal, replay, changed };
      }),
    );

    for (const { providerKey, normal, replay, changed } of results) {
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

async function dryRunFixture(
  identity: Readonly<{ providerKey: string; profileKey?: string; profileVersion: string }>,
  flow: "normal" | "changed" | "replay",
) {
  const fixtureCase = catalogProviderProfileFixtureCases().find(
    (candidate) =>
      candidate.providerKey === identity.providerKey &&
      candidate.profileVersion === identity.profileVersion &&
      (!identity.profileKey || candidate.profileKey === identity.profileKey) &&
      candidate.flow === flow,
  );
  if (!fixtureCase) {
    throw new Error(`Missing fixture case for ${identity.providerKey}:${identity.profileKey ?? "*"}:${flow}.`);
  }
  const version = catalogProviderIntegrationProfileVersions.find(
    (candidate) =>
      candidate.providerKey === identity.providerKey &&
      candidate.profileVersion === identity.profileVersion &&
      (!identity.profileKey || candidate.profileKey === identity.profileKey),
  );
  if (!version) {
    throw new Error(`Missing profile version for ${identity.providerKey}:${identity.profileKey ?? "*"}.`);
  }
  const payload = JSON.parse(
    await readFile(path.join(repositoryRoot(), version.fixtures.fixtureRoot, fixtureCase.payloadFile), "utf8"),
  ) as JsonValue;

  return dryRunCatalogProviderProfileVersion({
    store: profileStore(catalogProviderIntegrationProfileVersions),
    providerKey: identity.providerKey,
    profileVersion: fixtureCase.profileVersion,
    profileKey: fixtureCase.profileKey,
    ingestionUnitKey: fixtureCase.ingestionUnitKey,
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
    getProfileVersion: async (providerKey, profileVersion, selector) =>
      versions.find(
        (version) =>
          version.providerKey === providerKey &&
          version.profileVersion === profileVersion &&
          selectorMatchesVersion(selector, version),
      ) ?? null,
    getActiveProfileVersion: async (providerKey, selector) =>
      versions.find(
        (version) => version.providerKey === providerKey && version.active && selectorMatchesVersion(selector, version),
      ) ?? null,
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

function selectorMatchesVersion(
  selector: Readonly<{ profileKey?: string | null; ingestionUnitKey?: string | null }> | null | undefined,
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  const profileKey = selector?.profileKey?.trim().toLowerCase();
  const ingestionUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase();
  return (
    (!profileKey || version.profileKey.trim().toLowerCase() === profileKey) &&
    (!ingestionUnitKey ||
      (
        version.ingestionUnitIdentity?.unitKey ??
        version.executableMappingContract?.ingestionUnitIdentity?.unitKey ??
        ""
      )
        .trim()
        .toLowerCase() === ingestionUnitKey)
  );
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
}
