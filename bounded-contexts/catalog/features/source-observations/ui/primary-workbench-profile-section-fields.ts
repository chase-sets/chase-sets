import type { CatalogProviderProfileEditableSectionKey } from "../api/provider-profile-section-registry";
import { catalogProviderProfileSectionFields } from "../api/provider-profile-admin-contracts";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogProviderProfileVersionReview } from "./contracts";
import {
  arrayValue,
  booleanValue,
  expressionSummary,
  firstRecord,
  numberString,
  recordKeys,
  recordValue,
  stringArrayValue,
  stringValue,
} from "./primary-workbench-read-model-support";

export type ProfileSectionWorkspace = CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number];
export type ProfileSectionField = ProfileSectionWorkspace["fields"][number];

export function profileSectionFields(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  disabled: boolean,
): readonly ProfileSectionField[] {
  const profileRecord = recordValue(profile.profile);
  const contractRecord = recordValue(profile.executableMappingContract);
  const sourceObservation = recordValue(contractRecord?.sourceObservation);
  const normalizedObservation = recordValue(contractRecord?.normalizedObservation);
  const externalReferences = firstRecord(arrayValue(contractRecord?.externalReferences));
  const selectedOptions = recordValue(contractRecord?.selectedOptions);
  const referenceHierarchy = firstRecord(arrayValue(contractRecord?.referenceHierarchy));
  const duplicatePrevention = recordValue(contractRecord?.duplicatePrevention);
  const promotionCommandPlan = recordValue(contractRecord?.promotionCommandPlan);
  const connector = recordValue(profileRecord?.connector);
  const mappingConnector = recordValue(contractRecord?.connector);
  const catalogFieldMapping = recordValue(profileRecord?.catalogFieldMapping);
  const optionQueries = arrayValue(profileRecord?.optionQueries);
  const firstOptionQuery = firstRecord(optionQueries);
  const selectedOptionMapping = recordValue(profileRecord?.selectedOptionMapping);
  const selectedOptionDimension = firstRecord(arrayValue(selectedOptionMapping?.dimensions));
  const referenceHierarchyMapping = recordValue(profileRecord?.referenceHierarchyMapping);
  const duplicatePreventionMapping = recordValue(profileRecord?.duplicatePreventionMapping);
  const retirementPlan = recordValue(profile.retirementPlan);

  const edit = (key: string, value: string, options?: ProfileSectionField["options"]) =>
    editableField(section, key, value, disabled, options);

  switch (section) {
    case "basics":
      return [
        edit("displayName", profile.displayName),
        edit("lifecycle", profile.lifecycle),
        edit("status", profile.status),
        edit("capabilities", profile.capabilities.join(", ")),
        edit("supportedScopes", profile.supportedScopes.join(", ")),
        edit("languageOptions", profile.languageOptions.join(", ")),
      ];
    case "provider-options":
      return [
        // Its choices are the stored option queries, so the read model lists them.
        {
          ...edit(
            "optionQueryIndex",
            "0",
            optionQueries.map((value, index) => {
              const record = recordValue(value);
              return option(String(index), stringValue(record?.displayName) ?? `Option query ${index + 1}`);
            }),
          ),
          disabled: disabled || optionQueries.length === 0,
        },
        edit("optionQueryDisplayName", stringValue(firstOptionQuery?.displayName) ?? ""),
        edit("optionQueryScope", stringValue(firstOptionQuery?.scope) ?? ""),
        edit("optionQueryOperation", stringValue(firstOptionQuery?.operation) ?? ""),
      ];
    case "connector":
      return [
        edit("connectorKind", profile.connectorKind),
        edit("connectorBaseUrl", stringValue(connector?.baseUrl) ?? ""),
        edit("connectorTransportOwns", stringArrayValue(mappingConnector?.transportOwns).join(", ")),
        edit("connectorMappingOwns", stringArrayValue(mappingConnector?.mappingOwns).join(", ")),
      ];
    case "catalog-field-mapping":
      return [
        edit("blueprintKey", stringValue(catalogFieldMapping?.blueprintKey) ?? ""),
        edit("categoryKey", stringValue(catalogFieldMapping?.categoryKey) ?? ""),
        shown("fieldKeyCount", "Mapped field count", String(recordKeys(catalogFieldMapping?.fieldKeys).length)),
      ];
    case "source-contract":
      return [
        edit("sourceOwner", profile.sourceContract.owner),
        edit("sourceRepository", profile.sourceContract.repository ?? ""),
        edit("sourceCommit", profile.sourceContract.commit ?? ""),
        edit("sourceDocumentPath", profile.sourceContract.documentPath),
        edit("fixtureSetVersion", profile.sourceContract.fixtureSetVersion),
      ];
    case "fixtures":
      return [
        edit("fixtureRoot", profile.fixtures.fixtureRoot),
        edit("coveredFlows", profile.fixtures.coveredFlows.join(", ")),
        edit("liveProviderCallsAllowed", String(profile.fixtures.liveProviderCallsAllowed)),
      ];
    case "source-observation":
      return [
        edit("observationIdPath", expressionSummary(sourceObservation?.observationId)),
        edit("externalKeyPath", expressionSummary(sourceObservation?.externalKey)),
        edit("sourceUrlPath", expressionSummary(sourceObservation?.sourceUrl)),
        edit("sourceUpdatedAtPath", expressionSummary(sourceObservation?.sourceUpdatedAt)),
      ];
    case "normalized-observation":
      return [
        edit("normalizedOutputKind", stringValue(normalizedObservation?.outputKind) ?? profile.mappingOutputKind),
        edit("normalizedLanguagePath", expressionSummary(normalizedObservation?.languageCode)),
        shown(
          "normalizedFieldCount",
          "Normalized field count",
          String(recordKeys(normalizedObservation?.fields).length),
        ),
        shown("hashMaterialCount", "Hash material count", String(arrayValue(normalizedObservation?.hashMaterial).length)),
      ];
    case "external-references":
      return [
        edit("externalReferenceProviderKey", stringValue(externalReferences?.providerKey) ?? ""),
        edit("externalReferenceTarget", stringValue(externalReferences?.target) ?? ""),
        edit("externalKeyPrefix", stringValue(externalReferences?.externalKeyPrefix) ?? ""),
        shown(
          "externalReferenceCount",
          "Reference contract count",
          String(arrayValue(contractRecord?.externalReferences).length),
        ),
      ];
    case "selected-options":
      return [
        edit("selectedOptionDimensionKey", stringValue(selectedOptionDimension?.dimensionKey) ?? ""),
        shown(
          "selectedOptionSource",
          "Option source",
          stringValue(selectedOptions?.missingOrUnknownOptionPolicy) ?? stringValue(selectedOptionMapping?.source) ?? "",
        ),
        shown(
          "selectedOptionDimensionCount",
          "Dimension count",
          String(arrayValue(selectedOptionMapping?.dimensions).length),
        ),
      ];
    case "reference-hierarchy":
      return [
        edit("referenceHierarchyType", stringValue(referenceHierarchy?.targetTypeKey) ?? ""),
        edit(
          "referenceHierarchyProviderAttribute",
          stringValue(referenceHierarchy?.providerAttributeKey) ??
            stringValue(referenceHierarchyMapping?.providerAttributeKey) ??
            "",
        ),
        shown(
          "referenceHierarchyContractCount",
          "Hierarchy contract count",
          String(arrayValue(contractRecord?.referenceHierarchy).length),
        ),
      ];
    case "duplicate-prevention":
      return [
        edit(
          "exactExternalCatalogItemReferencesFirst",
          String(booleanValue(duplicatePrevention?.exactExternalCatalogItemReferencesFirst) ?? false),
        ),
        edit("ambiguousCandidatePolicy", stringValue(duplicatePrevention?.ambiguousCandidatePolicy) ?? ""),
        edit("replayPolicy", stringValue(duplicatePrevention?.replayPolicy) ?? ""),
        shown("duplicatePreventionMappingSource", "Mapping source", stringValue(duplicatePreventionMapping?.source) ?? ""),
      ];
    case "promotion-plan":
      return [
        edit("promotionPlanKind", stringValue(promotionCommandPlan?.planKind) ?? ""),
        edit("promotionRequiresReview", String(booleanValue(promotionCommandPlan?.requiresReview) ?? true)),
        shown("promotionCommandCount", "Command count", String(arrayValue(promotionCommandPlan?.commands).length)),
      ];
    case "retirement-plan":
      return [
        edit("retirementTrackingIssue", numberString(retirementPlan?.trackingIssue)),
        edit("retirementReason", stringValue(retirementPlan?.reason) ?? ""),
      ];
    case "migration-evidence":
      return [
        edit("migrationEvidenceText", profile.migrationEvidence?.evidenceText ?? ""),
        edit("migrationFixtureRunId", profile.migrationEvidence?.fixtureRunId ?? ""),
        // Catalog stamps these when it records the evidence.
        shown(
          "migrationFingerprintBefore",
          "Mapping fingerprint before",
          profile.migrationEvidence?.mappingFingerprintBefore ?? "",
        ),
        shown(
          "migrationFingerprintAfter",
          "Mapping fingerprint after",
          profile.migrationEvidence?.mappingFingerprintAfter ?? "",
        ),
        shown("migrationRecordedAt", "Recorded at", profile.migrationEvidence?.recordedAt ?? ""),
      ];
  }
}

// A field of the section's edit, drawn from Catalog's definition of the section's form. A fixed
// field is shown read-only, so a form does not post it.
function editableField(
  section: CatalogProviderProfileEditableSectionKey,
  key: string,
  value: string,
  disabled: boolean,
  options?: ProfileSectionField["options"],
): ProfileSectionField {
  const definition = catalogProviderProfileSectionFields[section].find((candidate) => candidate.key === key);
  if (!definition) {
    throw new Error(`Profile section '${section}' has no field '${key}'.`);
  }
  return {
    key,
    label: definition.label,
    value,
    control: definition.control,
    required: definition.required,
    disabled: disabled || definition.fixedValue !== null,
    helpText: definition.helpText,
    options: options ?? definition.options,
  };
}

// A value the section shows but its edit does not take (a count, a source, a Catalog stamp).
function shown(key: string, label: string, value: string): ProfileSectionField {
  return { key, label, value, control: "text", required: false, disabled: true, helpText: null, options: [] };
}

function option(value: string, label: string): ProfileSectionField["options"][number] {
  return { value, label };
}