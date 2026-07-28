import { describe, expect, it } from "vitest";
import { catalogProviderIntegrationProfileVersions } from "../provider-integration-profiles";
import {
  catalogProviderProfileEditableSectionDefinitions,
  catalogProviderProfileEditableSectionKeys,
  catalogProviderProfileEditableSectionMetadata,
  getCatalogProviderProfileSectionDefinition,
  parseCatalogProviderProfileSectionUpdateCommand,
  toCatalogProviderProfileSectionPatch,
} from "./provider-profile-section-registry";

describe("Catalog provider profile section registry", () => {
  it("enumerates one definition and metadata record for every editable section key", () => {
    expect(catalogProviderProfileEditableSectionDefinitions.map((definition) => definition.section)).toEqual(
      catalogProviderProfileEditableSectionKeys,
    );
    expect(new Set(catalogProviderProfileEditableSectionDefinitions.map((definition) => definition.section)).size).toBe(
      catalogProviderProfileEditableSectionKeys.length,
    );
    expect(catalogProviderProfileEditableSectionMetadata()).toEqual(
      catalogProviderProfileEditableSectionDefinitions.map((definition) => ({
        section: definition.section,
        displayName: definition.displayName,
        requiredPermission: "catalog.manage",
        rawJsonBacked: false,
      })),
    );
  });

  it("parses section commands through their registered validators", () => {
    expect(() =>
      parseCatalogProviderProfileSectionUpdateCommand(
        {
          optionQueries: {},
        },
        "provider-options",
      ),
    ).toThrow("optionQueries must be an array.");

    expect(
      parseCatalogProviderProfileSectionUpdateCommand(
        {
          section: "fixtures",
          displayName: "TCGdex Candidate",
        },
        "basics",
      ),
    ).toEqual({
      section: "basics",
      displayName: "TCGdex Candidate",
    });
  });

  it("composes profile basics patches from the registered section definition", () => {
    const base = requireSeededVersion("tcgdex");

    const patch = toCatalogProviderProfileSectionPatch(base, {
      section: "basics",
      lifecycle: "test",
      displayName: "TCGdex Candidate",
      languageOptions: ["en", "fr"],
    });

    expect(patch).toMatchObject({
      lifecycle: "test",
      profile: {
        displayName: "TCGdex Candidate",
        languageOptions: ["en", "fr"],
      },
      executableMappingContract: {
        displayName: "TCGdex Candidate",
        lifecycle: "test",
      },
    });
    expect(patch.profile?.providerKey).toBe(base.profile.providerKey);
  });

  it("keeps executable-contract requirements with their section definition", () => {
    const base = requireSeededVersion("tcgdex");
    const sourceObservationDefinition = getCatalogProviderProfileSectionDefinition("source-observation");

    expect(sourceObservationDefinition?.displayName).toBe("Source Observation");
    expect(() =>
      toCatalogProviderProfileSectionPatch(
        {
          ...base,
          executableMappingContract: undefined,
        },
        {
          section: "source-observation",
          sourceObservation: null,
        },
      ),
    ).toThrow("Profile section 'source-observation' requires an executable mapping contract.");
  });
});

function requireSeededVersion(providerKey: string) {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === providerKey);
  if (!version) {
    throw new Error(`Expected seeded ${providerKey} provider profile version.`);
  }
  return version;
}
