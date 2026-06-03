import { describe, expect, it } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  dryRunCatalogProviderProfileVersion,
  listCatalogProviderProfileVersionReviews,
} from "./provider-profile-review";

describe("Catalog provider profile review", () => {
  it("lists profile versions with validation status and review metadata", async () => {
    const reviews = await listCatalogProviderProfileVersionReviews(profileStore());

    expect(reviews.map((review) => [review.providerKey, review.profileVersion, review.validation.status])).toEqual([
      ["scrydex", "2026.06.03", "valid"],
      ["tcgdex", "2026.06.03", "valid"],
      ["tcgplayer", "2026.06.03", "valid"],
    ]);
    expect(reviews.find((review) => review.providerKey === "scrydex")).toMatchObject({
      connectorKind: "scrydex-scryfall-json",
      sourceContract: {
        fixtureSetVersion: "scrydex-scryfall-card-proof-v1",
      },
      fixtures: {
        liveProviderCallsAllowed: false,
      },
      hasExecutableMappingContract: true,
    });
  });

  it("dry-runs executable profiles with redacted payload and mapping evidence", async () => {
    const result = await dryRunCatalogProviderProfileVersion({
      store: profileStore(),
      providerKey: "scrydex",
      profileVersion: "2026.06.03",
      payload: scrydexPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.status).toBe("completed");
    expect(result.observation).toMatchObject({
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      normalized: {
        kind: "provider-product",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
      },
    });
    expect(result.redactedPayload).toMatchObject({
      prices: "[redacted]",
      auth: "[redacted]",
    });
    expect(result.hashMaterial).toHaveLength(1);
    expect(result.mergeCandidateEvidence.map((evidence) => evidence.value)).toEqual([14240, "157", "Time Spiral"]);
    expect(result.duplicatePreventionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleKey: "exact-external-catalog-item-reference",
          candidatePolicy: "reuse",
        }),
      ]),
    );
    expect(result.promotionCommandPlan.commands).toEqual([]);
  });
});

function profileStore(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
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

function scrydexPayload(): JsonValue {
  return {
    object: "card",
    id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
    name: "Fury Sliver",
    lang: "en",
    released_at: "2006-10-06",
    scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
    set: "tsp",
    set_name: "Time Spiral",
    collector_number: "157",
    image_uris: {
      normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
    },
    tcgplayer_id: 14240,
    prices: {
      usd: "0.42",
    },
    auth: {
      cookie: "TCGAuthTicket_Production=secret",
    },
  };
}
