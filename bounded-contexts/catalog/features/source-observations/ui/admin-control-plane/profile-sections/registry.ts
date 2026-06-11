import { t } from "@chase-sets/localization";
import {
  catalogProviderProfileEditableSectionKeys,
  type CatalogProviderProfileEditableSection,
  type CatalogProviderProfileEditableSectionKey,
} from "../../contracts";
import type { CatalogProviderProfileSectionModule, CatalogProviderProfileSectionRegistryItem } from "./types";

const loadPlaceholderEditor: CatalogProviderProfileSectionModule["loadEditor"] = () =>
  import("./lazy-editor-placeholder");

export const CATALOG_PROVIDER_PROFILE_SECTION_MODULES = [
  defineProfileSectionModule({
    section: "basics",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.basics"),
    area: "identity",
    formStateKey: "profile",
    commandSection: "basics",
  }),
  defineProfileSectionModule({
    section: "provider-options",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.provider.options"),
    area: "transport",
    formStateKey: "optionQueries",
    commandSection: "provider-options",
  }),
  defineProfileSectionModule({
    section: "connector",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.connector"),
    area: "transport",
    formStateKey: "connector",
    commandSection: "connector",
  }),
  defineProfileSectionModule({
    section: "catalog-field-mapping",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.catalog.field.mapping"),
    area: "mapping",
    formStateKey: null,
    commandSection: "catalog-field-mapping",
  }),
  defineProfileSectionModule({
    section: "source-contract",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.source.contract"),
    area: "governance",
    formStateKey: "sourceContract",
    commandSection: "source-contract",
  }),
  defineProfileSectionModule({
    section: "fixtures",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.fixtures"),
    area: "governance",
    formStateKey: "fixtures",
    commandSection: "fixtures",
  }),
  defineProfileSectionModule({
    section: "source-observation",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.source.observation"),
    area: "mapping",
    formStateKey: null,
    commandSection: "source-observation",
  }),
  defineProfileSectionModule({
    section: "normalized-observation",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.normalized.observation"),
    area: "mapping",
    formStateKey: "normalizedObservation",
    commandSection: "normalized-observation",
  }),
  defineProfileSectionModule({
    section: "external-references",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.external.references"),
    area: "mapping",
    formStateKey: "externalReferences",
    commandSection: "external-references",
  }),
  defineProfileSectionModule({
    section: "selected-options",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.profile.section.selected.options"),
    area: "mapping",
    formStateKey: "selectedOptionMapping",
    commandSection: "selected-options",
  }),
  defineProfileSectionModule({
    section: "reference-hierarchy",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.reference.hierarchy"),
    area: "mapping",
    formStateKey: "referenceHierarchy",
    commandSection: "reference-hierarchy",
  }),
  defineProfileSectionModule({
    section: "duplicate-prevention",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.duplicate.prevention"),
    area: "mapping",
    formStateKey: "duplicatePrevention",
    commandSection: "duplicate-prevention",
  }),
  defineProfileSectionModule({
    section: "promotion-plan",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.promotion.plan"),
    area: "mapping",
    formStateKey: "promotionPlan",
    commandSection: "promotion-plan",
  }),
  defineProfileSectionModule({
    section: "retirement-plan",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.retirement.plan"),
    area: "governance",
    formStateKey: "retirementPlan",
    commandSection: "retirement-plan",
  }),
  defineProfileSectionModule({
    section: "migration-evidence",
    label: t("catalog.features.sourceObservations.ui.adminControlPlane.migration.evidence"),
    area: "governance",
    formStateKey: "migrationEvidence",
    commandSection: "migration-evidence",
  }),
] as const satisfies readonly CatalogProviderProfileSectionModule[];

export const CATALOG_PROVIDER_PROFILE_SECTION_SAVE_ORDER = [
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
] as const satisfies readonly CatalogProviderProfileEditableSectionKey[];

export function profileSectionRegistryItems(
  editableSections: readonly CatalogProviderProfileEditableSection[],
): CatalogProviderProfileSectionRegistryItem[] {
  const editableBySection = new Map(editableSections.map((section) => [section.section, section]));
  return CATALOG_PROVIDER_PROFILE_SECTION_MODULES.map((module) => ({
    module,
    editableSection: editableBySection.get(module.section) ?? null,
  }));
}

export function getProfileSectionModule(
  section: CatalogProviderProfileEditableSectionKey,
): CatalogProviderProfileSectionModule {
  return CATALOG_PROVIDER_PROFILE_SECTION_MODULES.find((module) => module.section === section) ?? assertNeverSection();
}

function defineProfileSectionModule(
  module: Omit<CatalogProviderProfileSectionModule, "loadEditor">,
): CatalogProviderProfileSectionModule {
  return {
    ...module,
    loadEditor: loadPlaceholderEditor,
  };
}

function assertNeverSection(): never {
  throw new Error("Unknown provider profile section.");
}

const registeredSections = new Set(CATALOG_PROVIDER_PROFILE_SECTION_MODULES.map((module) => module.section));
for (const section of catalogProviderProfileEditableSectionKeys) {
  if (!registeredSections.has(section)) {
    throw new Error(`Missing provider profile section UI module: ${section}`);
  }
}
