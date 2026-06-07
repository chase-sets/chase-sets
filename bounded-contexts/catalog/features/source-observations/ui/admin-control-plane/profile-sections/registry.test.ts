import { describe, expect, it } from "vitest";
import { catalogProviderProfileEditableSectionKeys } from "../../contracts";
import {
  CATALOG_PROVIDER_PROFILE_SECTION_MODULES,
  CATALOG_PROVIDER_PROFILE_SECTION_SAVE_ORDER,
  getProfileSectionModule,
  profileSectionRegistryItems,
} from "./registry";

describe("Catalog provider profile section registry", () => {
  it("covers every server-declared editable section", () => {
    expect(CATALOG_PROVIDER_PROFILE_SECTION_MODULES.map((module) => module.section)).toEqual(
      catalogProviderProfileEditableSectionKeys,
    );
    expect([...CATALOG_PROVIDER_PROFILE_SECTION_SAVE_ORDER].sort()).toEqual(
      [...catalogProviderProfileEditableSectionKeys].sort(),
    );
    expect(CATALOG_PROVIDER_PROFILE_SECTION_SAVE_ORDER).toEqual([
      "basics",
      "source-contract",
      "retirement-plan",
      "provider-options",
      "connector",
      "catalog-field-mapping",
      "fixtures",
      "source-observation",
      "normalized-observation",
      "external-references",
      "selected-options",
      "reference-hierarchy",
      "duplicate-prevention",
      "promotion-plan",
      "migration-evidence",
    ]);
  });

  it("enumerates profile sections in registry order with server editability metadata", () => {
    const items = profileSectionRegistryItems([
      {
        section: "basics",
        displayName: "Basics",
        requiredPermission: "catalog.manage",
        rawJsonBacked: false,
      },
      {
        section: "fixtures",
        displayName: "Fixtures",
        requiredPermission: "catalog.manage",
        rawJsonBacked: false,
      },
    ]);

    expect(items.map((item) => item.module.section)).toEqual(catalogProviderProfileEditableSectionKeys);
    expect(items.filter((item) => item.editableSection).map((item) => item.module.section)).toEqual([
      "basics",
      "fixtures",
    ]);
  });

  it("exposes lazy-loadable editor modules without mounting the integration page", async () => {
    const module = await getProfileSectionModule("basics").loadEditor();

    expect(module.default).toEqual(expect.any(Function));
  }, 180000);
});
