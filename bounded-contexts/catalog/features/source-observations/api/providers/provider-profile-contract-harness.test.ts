import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import type { CatalogProviderProfileFixtureFlow } from "./provider-integration-mapping-contract";
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
      "lorcanajson@2026.06.23",
      "lorcanajson@2026.06.23",
      "lorcast@2026.06.23",
      "lorcast@2026.06.23",
      "scryfall@2026.06.19",
      "scryfall@2026.06.19",
      "scrydex@2026.06.22",
      "scrydex@2026.06.22",
      "scrydex@2026.06.22",
      "scrydex@2026.06.23",
      "scrydex@2026.06.23",
      "scrydex@2026.06.23",
      "ygoprodeck@2026.06.21",
      "ygoprodeck@2026.06.21",
      "ygojson@2026.06.21",
      "ygojson@2026.07.14",
      "tcgdex@2026.06.03",
      "tcgplayer@2026.06.19",
      "tcgplayer@2026.06.19",
      "tcgplayer@2026.06.20",
      "tcgplayer@2026.06.22",
      "tcgplayer@2026.06.23",
      "tcgplayer@2026.06.23",
      "tcgplayer@2026.06.23",
      "tcgplayer@2026.06.05",
      "tcgplayer@2026.07.13",
    ]);
  });

  it("keeps replay deterministic while changed fixtures move the source hash", async () => {
    const identities = [
      { providerKey: "mtgjson", profileKey: "mtg-card-reference-data", profileVersion: "2026.06.19" },
      { providerKey: "mtgjson", profileKey: "mtg-set-reference-data", profileVersion: "2026.06.19" },
      { providerKey: "lorcanajson", profileKey: "lorcana-card-reference-data", profileVersion: "2026.06.23" },
      { providerKey: "lorcanajson", profileKey: "lorcana-set-reference-data", profileVersion: "2026.06.23" },
      { providerKey: "lorcast", profileKey: "lorcana-card-reference-data", profileVersion: "2026.06.23" },
      { providerKey: "lorcast", profileKey: "lorcana-set-reference-data", profileVersion: "2026.06.23" },
      { providerKey: "scryfall", profileKey: "mtg-card-print-reference-data", profileVersion: "2026.06.19" },
      { providerKey: "scryfall", profileKey: "mtg-card-image-evidence", profileVersion: "2026.06.19" },
      { providerKey: "scrydex", profileKey: "lorcana-card-print-source-observation", profileVersion: "2026.06.23" },
      { providerKey: "scrydex", profileKey: "lorcana-set-reference-data", profileVersion: "2026.06.23" },
      { providerKey: "scrydex", profileKey: "lorcana-sealed-product-source-observation", profileVersion: "2026.06.23" },
      { providerKey: "ygoprodeck", profileKey: "yugioh-card-print-reference-data", profileVersion: "2026.06.21" },
      { providerKey: "ygoprodeck", profileKey: "yugioh-set-reference-data", profileVersion: "2026.06.21" },
      { providerKey: "ygojson", profileKey: "yugioh-set-reference-data", profileVersion: "2026.06.21" },
      { providerKey: "ygojson", profileKey: "yugioh-sealed-product-reference-data", profileVersion: "2026.07.14" },
      { providerKey: "tcgdex", profileVersion: "2026.06.03" },
      { providerKey: "tcgplayer", profileKey: "mtg-single-card-product-sku", profileVersion: "2026.06.19" },
      { providerKey: "tcgplayer", profileKey: "mtg-sealed-product-sku", profileVersion: "2026.06.19" },
      { providerKey: "tcgplayer", profileKey: "yugioh-single-card-product-sku", profileVersion: "2026.06.20" },
      { providerKey: "tcgplayer", profileKey: "one-piece-single-card-product-sku", profileVersion: "2026.06.22" },
      { providerKey: "tcgplayer", profileKey: "one-piece-sealed-product-sku", profileVersion: "2026.06.23" },
      { providerKey: "tcgplayer", profileKey: "lorcana-single-card-product-sku", profileVersion: "2026.06.23" },
      { providerKey: "tcgplayer", profileKey: "lorcana-sealed-product-sku", profileVersion: "2026.06.23" },
      { providerKey: "tcgplayer", profileKey: "pokemon-single-card-product-sku", profileVersion: "2026.06.05" },
      { providerKey: "tcgplayer", profileKey: "pokemon-sealed-product-sku", profileVersion: "2026.07.13" },
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

  it("maps the TCGdex collector number alone through normalization and the executable promotion path", async () => {
    const result = await dryRunFixture({ providerKey: "tcgdex", profileVersion: "2026.06.03" }, "normal");
    const cardNumberCommand = result.promotionCommandPlan.commands.find(
      (command) => command.commandName === "SetCatalogItemFieldValue",
    );

    expect(result.status).toBe("completed");
    expect(result.observation?.normalized).toMatchObject({
      kind: "pokemon-card",
      cardNumber: "1",
      expansionCardCount: null,
    });
    expect(cardNumberCommand?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "SetCatalogItemFieldValue.fieldKey",
          value: "card-number",
        }),
        expect.objectContaining({
          path: "SetCatalogItemFieldValue.value",
          value: "001",
        }),
      ]),
    );
  });

  it("classifies Magic fixture dry-runs as blocked, changed, ambiguous, promotable, and replay-safe", async () => {
    const [blockedPartial, normalSet, replaySet, changedSet, ambiguousSealed, promotableSealed] = await Promise.all([
      dryRunFixture(
        { providerKey: "scryfall", profileKey: "mtg-card-print-reference-data", profileVersion: "2026.06.19" },
        "partial",
      ),
      dryRunFixture(
        { providerKey: "mtgjson", profileKey: "mtg-set-reference-data", profileVersion: "2026.06.19" },
        "normal",
      ),
      dryRunFixture(
        { providerKey: "mtgjson", profileKey: "mtg-set-reference-data", profileVersion: "2026.06.19" },
        "replay",
      ),
      dryRunFixture(
        { providerKey: "mtgjson", profileKey: "mtg-set-reference-data", profileVersion: "2026.06.19" },
        "changed",
      ),
      dryRunFixture(
        { providerKey: "tcgplayer", profileKey: "mtg-sealed-product-sku", profileVersion: "2026.06.19" },
        "ambiguous",
      ),
      dryRunFixture(
        { providerKey: "tcgplayer", profileKey: "mtg-sealed-product-sku", profileVersion: "2026.06.19" },
        "normal",
      ),
    ]);

    expect(blockedPartial.status).toBe("blocked");
    expect(blockedPartial.diagnosticLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "normalizedObservation.fields.name.selector",
          sectionKey: "normalized-observation",
          fixtureFlow: "partial",
        }),
      ]),
    );
    expect(normalSet.observation?.sourceRecordHash).toBe(replaySet.observation?.sourceRecordHash);
    expect(normalSet.observation?.sourceRecordHash).not.toBe(changedSet.observation?.sourceRecordHash);
    expect(normalSet.observation?.sourceMappingFingerprint).toBe(replaySet.observation?.sourceMappingFingerprint);
    expect(normalSet.promotionCommandPlan.commands).toEqual([]);
    expect(ambiguousSealed).toMatchObject({
      status: "completed",
      duplicatePreventionPolicy: {
        ambiguousCandidatePolicy: "block-promotion",
        replayPolicy: "same-profile-version",
      },
    });
    expect(ambiguousSealed.duplicatePreventionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleKey: "sealed-product-deterministic-fields", candidatePolicy: "review-only" }),
        expect.objectContaining({ ruleKey: "barcode-gtin-review", candidatePolicy: "review-only" }),
      ]),
    );
    expect(promotableSealed.promotionCommandPlan.commands.map((command) => command.commandName)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "LinkExternalCatalogItemReference",
    ]);
    expect(
      promotableSealed.promotionCommandPlan.commands.flatMap((command) => command.inputs.map((input) => input.path)),
    ).toEqual(
      expect.arrayContaining([
        "CreateCatalogItem.title",
        "AssignBlueprintToCatalogItem.blueprintKey",
        "SetCatalogItemFieldValue.value",
        "LinkExternalCatalogItemReference.references",
      ]),
    );
  });

  it("classifies Pokemon sealed-product dry-runs as blocked, ambiguous, promotable, and replay-safe", async () => {
    const [blockedPartial, ambiguousSealed, promotableSealed, replaySealed] = await Promise.all([
      dryRunFixture(
        { providerKey: "tcgplayer", profileKey: "pokemon-sealed-product-sku", profileVersion: "2026.07.13" },
        "partial",
      ),
      dryRunFixture(
        { providerKey: "tcgplayer", profileKey: "pokemon-sealed-product-sku", profileVersion: "2026.07.13" },
        "ambiguous",
      ),
      dryRunFixture(
        { providerKey: "tcgplayer", profileKey: "pokemon-sealed-product-sku", profileVersion: "2026.07.13" },
        "normal",
      ),
      dryRunFixture(
        { providerKey: "tcgplayer", profileKey: "pokemon-sealed-product-sku", profileVersion: "2026.07.13" },
        "replay",
      ),
    ]);

    expect(blockedPartial.status).toBe("blocked");
    expect(ambiguousSealed).toMatchObject({
      status: "completed",
      duplicatePreventionPolicy: {
        ambiguousCandidatePolicy: "block-promotion",
        replayPolicy: "same-profile-version",
      },
    });
    expect(promotableSealed.observation?.sourceRecordHash).toBe(replaySealed.observation?.sourceRecordHash);
    expect(promotableSealed.observation?.sourceMappingFingerprint).toBe(
      replaySealed.observation?.sourceMappingFingerprint,
    );
    expect(promotableSealed.promotionCommandPlan.commands.map((command) => command.commandName)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "LinkExternalCatalogItemReference",
    ]);
    expect(
      promotableSealed.promotionCommandPlan.commands.flatMap((command) => command.inputs.map((input) => input.path)),
    ).toEqual(
      expect.arrayContaining([
        "CreateCatalogItem.title",
        "AssignBlueprintToCatalogItem.blueprintKey",
        "SetCatalogItemFieldValue.value",
        "LinkExternalCatalogItemReference.references",
      ]),
    );
  });

  it("dry-runs YGOJSON sealed products as promotable and replay-safe", async () => {
    const identity = {
      providerKey: "ygojson",
      profileKey: "yugioh-sealed-product-reference-data",
      profileVersion: "2026.07.14",
    };
    const [promotable, replay] = await Promise.all([
      dryRunFixture(identity, "normal"),
      dryRunFixture(identity, "replay"),
    ]);

    expect(promotable.status).toBe("completed");
    expect(promotable.observation?.sourceRecordHash).toBe(replay.observation?.sourceRecordHash);
    expect(promotable.observation?.sourceMappingFingerprint).toBe(replay.observation?.sourceMappingFingerprint);
    expect(promotable.promotionCommandPlan.commands.map((command) => command.commandName)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "SetCatalogItemImageUrls",
      "LinkExternalCatalogItemReference",
      "LinkExternalProductReference",
    ]);
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
  flow: CatalogProviderProfileFixtureFlow,
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
    fixtureFlow: flow,
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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
}
