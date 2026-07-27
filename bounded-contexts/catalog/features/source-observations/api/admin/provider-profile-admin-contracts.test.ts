import { describe, expect, it } from "vitest";
import {
  CatalogProviderProfileSectionValidationError,
  parseCatalogProviderProfileSectionUpdateCommand,
} from "./provider-profile-admin-contracts";

describe("provider profile admin contracts", () => {
  it("parses section commands using the route section as authoritative", () => {
    const command = parseCatalogProviderProfileSectionUpdateCommand(
      {
        section: "fixtures",
        lifecycle: "test",
        displayName: "TCGdex Candidate",
        status: "planned",
        capabilities: ["provider-option-query"],
        supportedScopes: ["language"],
        languageOptions: ["en"],
      },
      "basics",
    );

    expect(command).toEqual({
      section: "basics",
      lifecycle: "test",
      displayName: "TCGdex Candidate",
      status: "planned",
      capabilities: ["provider-option-query"],
      supportedScopes: ["language"],
      languageOptions: ["en"],
    });
  });

  it("rejects malformed section commands with contract errors", () => {
    expect(() =>
      parseCatalogProviderProfileSectionUpdateCommand(
        {
          optionQueries: {},
        },
        "provider-options",
      ),
    ).toThrow(CatalogProviderProfileSectionValidationError);

    expect(() =>
      parseCatalogProviderProfileSectionUpdateCommand(
        {
          optionQueries: {},
        },
        "provider-options",
      ),
    ).toThrow("optionQueries must be an array.");
  });

  it("requires one editable field for partial executable mapping sections", () => {
    expect(() =>
      parseCatalogProviderProfileSectionUpdateCommand({
        section: "normalized-observation",
      }),
    ).toThrow("Profile section 'normalized-observation' must include at least one editable field.");
  });

  it("validates source contract structure", () => {
    const command = parseCatalogProviderProfileSectionUpdateCommand({
      section: "source-contract",
      sourceContract: {
        owner: "catalog",
        repository: null,
        commit: null,
        documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
        fixtureSetVersion: "2026.06.05",
      },
    });

    expect(command.section).toBe("source-contract");

    expect(() =>
      parseCatalogProviderProfileSectionUpdateCommand({
        section: "source-contract",
        sourceContract: {
          owner: "catalog",
          repository: null,
          commit: 123,
          documentPath: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
          fixtureSetVersion: "2026.06.05",
        },
      }),
    ).toThrow("sourceContract.commit must be a string or null.");
  });
});
