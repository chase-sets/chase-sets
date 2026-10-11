import { describe, expect, it } from "vitest";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { catalogMergeCandidateTargetId, requirePinnedProfileEligible } from "./catalog-merge-candidate-application";

const pinned = { providerKey: "tcgdex", profileKey: "pokemon-tcg", profileVersion: "2026.06.24" };

function version(
  overrides: Partial<{
    profileKey: string;
    profileVersion: string;
    lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"];
    active: boolean;
    capabilities: readonly string[];
    unitKey: string;
  }> = {},
): CatalogProviderIntegrationProfileVersionRecord {
  return {
    providerKey: "tcgdex",
    profileKey: overrides.profileKey ?? pinned.profileKey,
    profileVersion: overrides.profileVersion ?? pinned.profileVersion,
    lifecycle: overrides.lifecycle ?? "active",
    active: overrides.active ?? true,
    ingestionUnitIdentity: { unitKey: overrides.unitKey ?? "tcgdex:pokemon:en" },
    profile: {
      status: "active",
      capabilities: overrides.capabilities ?? ["catalog-item-promotion"],
      normalizedObservationMapping: { kind: "pokemon-card" },
    },
  } as unknown as CatalogProviderIntegrationProfileVersionRecord;
}

const deprecated = () => version({ lifecycle: "deprecated", active: false });

describe("pinned application profile eligibility", () => {
  it("keeps an active pinned profile eligible", () => {
    expect(requirePinnedProfileEligible([version()], pinned)).toMatchObject(pinned);
  });

  it("keeps a pin eligible when a competing version of the same profile was activated", () => {
    const successor = version({ profileVersion: "2026.10.01" });
    expect(requirePinnedProfileEligible([deprecated(), successor], pinned)).toMatchObject({
      ...pinned,
      lifecycle: "deprecated",
    });
  });

  it.each([
    ["deprecated with no successor", [deprecated()]],
    [
      "deprecated beside an unrelated active unit",
      [
        deprecated(),
        version({ profileKey: "pokemon-tcg-ja", profileVersion: "2026.10.01", unitKey: "tcgdex:pokemon:ja" }),
      ],
    ],
    ["retired", [version({ lifecycle: "retired", active: false })]],
    ["stripped of promotion capability", [version({ capabilities: ["source-observation-import"] })]],
  ])("refuses a pin that was %s", (_name, versions) => {
    expect(() => requirePinnedProfileEligible(versions, pinned)).toThrow("promotion-application-profile-revoked");
  });

  it("refuses a pin whose record is missing or duplicated", () => {
    expect(() => requirePinnedProfileEligible([], pinned)).toThrow("promotion-application-profile-missing");
    expect(() => requirePinnedProfileEligible([version(), version()], pinned)).toThrow(
      "promotion-application-profile-missing",
    );
  });

  it("allocates a deterministic candidate target only from the candidate id", () => {
    expect(catalogMergeCandidateTargetId("cand_a")).toBe(catalogMergeCandidateTargetId("cand_a"));
    expect(catalogMergeCandidateTargetId("cand_a")).toMatch(/^cat_candidate_[a-f0-9]{64}$/);
    expect(catalogMergeCandidateTargetId("cand_a")).not.toBe(catalogMergeCandidateTargetId("cand_b"));
  });
});
