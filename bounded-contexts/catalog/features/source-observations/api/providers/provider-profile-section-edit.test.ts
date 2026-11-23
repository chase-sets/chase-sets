import { describe, expect, it } from "vitest";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import {
  catalogProviderProfileSectionCommandFromEdit,
  catalogProviderProfileSectionFieldKeys,
  catalogProviderProfileSectionFields,
  parseCatalogProviderProfileSectionEdit,
} from "./provider-profile-section-edit";
import { catalogProviderProfileEditableSectionKeys } from "./provider-profile-section-registry";

describe("Catalog provider profile section edit", () => {
  it("names the fields of every editable section", () => {
    expect(Object.keys(catalogProviderProfileSectionFieldKeys)).toEqual([...catalogProviderProfileEditableSectionKeys]);
  });

  it("describes each section's form, and its edit takes exactly the fields Catalog does not fix", () => {
    for (const section of catalogProviderProfileEditableSectionKeys) {
      const fields = catalogProviderProfileSectionFields[section];
      expect(new Set(fields.map((field) => field.key)).size, section).toBe(fields.length);
      expect(catalogProviderProfileSectionFieldKeys[section], section).toEqual(
        fields.filter((field) => field.fixedValue === null).map((field) => field.key),
      );
    }
    const fixed = catalogProviderProfileEditableSectionKeys.flatMap((section) =>
      catalogProviderProfileSectionFields[section]
        .filter((field) => field.fixedValue !== null)
        .map((field) => [section, field.key, field.fixedValue]),
    );
    expect(fixed).toEqual([
      ["fixtures", "liveProviderCallsAllowed", "false"],
      ["promotion-plan", "promotionRequiresReview", "true"],
    ]);
  });

  it("describes the defaults its edit applies", () => {
    const defaults = catalogProviderProfileEditableSectionKeys.flatMap((section) =>
      catalogProviderProfileSectionFields[section]
        .filter((field) => field.defaultValue !== null)
        .map((field) => [section, field.key, field.defaultValue]),
    );
    // "applies Catalog's defaults" below shows the edit applying each of these.
    expect(defaults).toEqual([
      ["external-references", "externalReferenceTarget", "catalog-item-reference"],
      ["duplicate-prevention", "ambiguousCandidatePolicy", "review-only"],
      ["duplicate-prevention", "replayPolicy", "same-profile-version"],
      ["promotion-plan", "promotionPlanKind", "catalog-item-promotion"],
      ["retirement-plan", "retirementReason", "Remove retired profile completely before launch."],
    ]);
  });
  it("takes the section's fields as strings, drops a fixed value sent as it is, and refuses the rest", () => {
    expect(
      parseCatalogProviderProfileSectionEdit({ fixtureRoot: "f", liveProviderCallsAllowed: "false" }, "fixtures"),
    ).toEqual({ section: "fixtures", fields: { fixtureRoot: "f" } });
    expect(() => parseCatalogProviderProfileSectionEdit({ liveProviderCallsAllowed: "true" }, "fixtures")).toThrow(
      "fields.liveProviderCallsAllowed must remain false.",
    );
    expect(() =>
      parseCatalogProviderProfileSectionEdit({ promotionRequiresReview: "false" }, "promotion-plan"),
    ).toThrow("fields.promotionRequiresReview must remain true.");
    expect(() => parseCatalogProviderProfileSectionEdit({ migrationRecordedAt: "x" }, "migration-evidence")).toThrow(
      "Profile section 'migration-evidence' has no field 'migrationRecordedAt'.",
    );
    expect(() => parseCatalogProviderProfileSectionEdit({ displayName: 1 }, "basics")).toThrow(
      "fields.displayName must be a string.",
    );
    expect(() => parseCatalogProviderProfileSectionEdit(undefined, "basics")).toThrow(
      "fields must be a JSON object of the section's fields.",
    );
    expect(() => parseCatalogProviderProfileSectionEdit({}, "operator-session")).toThrow(
      "Unsupported profile section update command.",
    );
  });

  it("keeps a field not sent and clears a nullable one sent blank", () => {
    const version = tcgdex();
    const command = catalogProviderProfileSectionCommandFromEdit(version, {
      section: "source-contract",
      fields: { sourceCommit: " ", sourceOwner: " chase-sets/catalog-next " },
    });
    expect(command).toEqual({
      section: "source-contract",
      sourceContract: {
        ...version.sourceContract,
        owner: "chase-sets/catalog-next",
        repository: version.sourceContract.repository,
        commit: null,
      },
    });
  });

  it("applies Catalog's fixed values whatever is stored", () => {
    const version = tcgdex();
    const stored = {
      ...version,
      fixtures: { ...version.fixtures, liveProviderCallsAllowed: true as unknown as false },
    };
    expect(catalogProviderProfileSectionCommandFromEdit(stored, { section: "fixtures", fields: {} })).toMatchObject({
      fixtures: { liveProviderCallsAllowed: false },
    });
    expect(
      catalogProviderProfileSectionCommandFromEdit(version, { section: "promotion-plan", fields: {} }),
    ).toMatchObject({
      promotionCommandPlan: { requiresReview: true },
    });
    expect(
      catalogProviderProfileSectionCommandFromEdit(version, {
        section: "retirement-plan",
        fields: { retirementTrackingIssue: "42" },
      }),
    ).toMatchObject({ retirementPlan: { trackingIssue: 42, removeAfter: "executable-mapping-contract-activated" } });
  });

  it("applies Catalog's defaults where neither the edit nor the stored section has a value", () => {
    const bare = withoutMappingDetails(tcgdex());
    expect(catalogProviderProfileSectionCommandFromEdit(bare, { section: "promotion-plan", fields: {} })).toMatchObject(
      {
        promotionCommandPlan: { planKind: "catalog-item-promotion", requiresReview: true },
      },
    );
    expect(
      catalogProviderProfileSectionCommandFromEdit(bare, {
        section: "duplicate-prevention",
        fields: { exactExternalCatalogItemReferencesFirst: "on" },
      }),
    ).toMatchObject({
      duplicatePreventionContract: {
        exactExternalCatalogItemReferencesFirst: true,
        ambiguousCandidatePolicy: "review-only",
        replayPolicy: "same-profile-version",
      },
    });
    expect(
      catalogProviderProfileSectionCommandFromEdit(bare, { section: "external-references", fields: {} }),
    ).toMatchObject({
      externalReferenceContracts: [{ providerKey: "tcgdex", target: "catalog-item-reference", externalKeyPrefix: "" }],
    });
    expect(
      catalogProviderProfileSectionCommandFromEdit(
        { ...bare, retirementPlan: null },
        { section: "retirement-plan", fields: { retirementTrackingIssue: "7" } },
      ),
    ).toMatchObject({ retirementPlan: { diagnosticText: "Remove retired profile completely before launch." } });
    expect(
      catalogProviderProfileSectionCommandFromEdit(bare, {
        section: "retirement-plan",
        fields: { retirementReason: " " },
      }),
    ).toEqual({ section: "retirement-plan", retirementPlan: null });
  });

  it("keeps a stored promotion plan kind the edit does not send", () => {
    const version = tcgdex();
    const contract = version.executableMappingContract!;
    const stored = {
      ...version,
      executableMappingContract: {
        ...contract,
        promotionCommandPlan: { ...contract.promotionCommandPlan, planKind: "stored-kind" },
      },
    } as unknown as CatalogProviderIntegrationProfileVersionRecord;
    expect(
      catalogProviderProfileSectionCommandFromEdit(stored, { section: "promotion-plan", fields: {} }),
    ).toMatchObject({
      promotionCommandPlan: { planKind: "stored-kind" },
    });
  });

  it("reads an unchecked checkbox as unchecked", () => {
    expect(
      catalogProviderProfileSectionCommandFromEdit(tcgdex(), { section: "duplicate-prevention", fields: {} }),
    ).toMatchObject({ duplicatePreventionContract: { exactExternalCatalogItemReferencesFirst: false } });
  });

  it("sets a changed path and keeps an expression whose shown value was posted back unchanged", () => {
    const version = tcgdex();
    const contract = version.executableMappingContract!;
    const template = {
      owner: "catalog-truth",
      uses: ["source-payload"],
      selector: { kind: "template", template: "{id}" },
    };
    const stored = {
      ...version,
      executableMappingContract: {
        ...contract,
        sourceObservation: { ...contract.sourceObservation!, observationId: template },
      },
    } as unknown as CatalogProviderIntegrationProfileVersionRecord;

    const unchanged = catalogProviderProfileSectionCommandFromEdit(stored, {
      section: "source-observation",
      fields: { observationIdPath: "{id}" },
    });
    expect(unchanged).toMatchObject({ sourceObservation: { observationId: template } });

    const changed = catalogProviderProfileSectionCommandFromEdit(stored, {
      section: "source-observation",
      fields: { observationIdPath: "$.card.id" },
    });
    expect(changed).toMatchObject({
      sourceObservation: { observationId: { owner: "catalog-truth", selector: { kind: "path", path: "$.card.id" } } },
    });
  });

  it("sends only what the operator wrote as migration evidence", () => {
    expect(
      catalogProviderProfileSectionCommandFromEdit(tcgdex(), {
        section: "migration-evidence",
        fields: { migrationEvidenceText: " Replayed. ", migrationFixtureRunId: " " },
      }),
    ).toEqual({ section: "migration-evidence", migrationEvidence: { evidenceText: "Replayed.", fixtureRunId: null } });
  });
});

function tcgdex(): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find((candidate) => candidate.providerKey === "tcgdex");
  if (!version?.executableMappingContract) {
    throw new Error("Expected the seeded TCGdex profile version with a mapping contract.");
  }
  return version;
}

function withoutMappingDetails(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIntegrationProfileVersionRecord {
  const contract = version.executableMappingContract!;
  return {
    ...version,
    executableMappingContract: {
      ...contract,
      promotionCommandPlan: {} as typeof contract.promotionCommandPlan,
      duplicatePrevention: {} as typeof contract.duplicatePrevention,
      externalReferences: [],
    },
  };
}
