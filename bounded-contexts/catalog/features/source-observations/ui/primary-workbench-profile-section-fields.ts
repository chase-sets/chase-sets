import type { CatalogProviderProfileEditableSectionKey } from "../api/provider-profile-section-registry";
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

  switch (section) {
    case "basics":
      return [
        field("displayName", "Display name", profile.displayName, "text", disabled, true),
        field("lifecycle", "Lifecycle", profile.lifecycle, "select", disabled, true, null, [
          option("draft", "Draft"),
          option("test", "Test"),
        ]),
        field("status", "Status", profile.status, "select", disabled, true, null, [
          option("active", "Active"),
          option("planned", "Planned"),
        ]),
        field("capabilities", "Capabilities", profile.capabilities.join(", "), "tags", disabled),
        field("supportedScopes", "Supported scopes", profile.supportedScopes.join(", "), "tags", disabled),
        field("languageOptions", "Languages", profile.languageOptions.join(", "), "tags", disabled),
      ];
    case "provider-options":
      return [
        field("optionQueryIndex", "Option query", "0", "select", disabled || optionQueries.length === 0, true, null, [
          ...optionQueries.map((value, index) => {
            const record = recordValue(value);
            return option(String(index), stringValue(record?.displayName) ?? `Option query ${index + 1}`);
          }),
        ]),
        field(
          "optionQueryDisplayName",
          "Option label",
          stringValue(firstOptionQuery?.displayName) ?? "",
          "text",
          disabled,
        ),
        field("optionQueryScope", "Scope", stringValue(firstOptionQuery?.scope) ?? "", "text", disabled),
        field("optionQueryOperation", "Operation", stringValue(firstOptionQuery?.operation) ?? "", "text", disabled),
      ];
    case "connector":
      return [
        field("connectorKind", "Connector kind", profile.connectorKind, "text", disabled, true),
        field("connectorBaseUrl", "Base URL", stringValue(connector?.baseUrl) ?? "", "text", disabled),
        field(
          "connectorTransportOwns",
          "Transport responsibilities",
          stringArrayValue(mappingConnector?.transportOwns).join(", "),
          "tags",
          disabled,
        ),
        field(
          "connectorMappingOwns",
          "Mapping responsibilities",
          stringArrayValue(mappingConnector?.mappingOwns).join(", "),
          "tags",
          disabled,
        ),
      ];
    case "catalog-field-mapping":
      return [
        field("blueprintKey", "Blueprint key", stringValue(catalogFieldMapping?.blueprintKey) ?? "", "text", disabled),
        field("categoryKey", "Category key", stringValue(catalogFieldMapping?.categoryKey) ?? "", "text", disabled),
        field(
          "fieldKeyCount",
          "Mapped field count",
          String(recordKeys(catalogFieldMapping?.fieldKeys).length),
          "text",
          true,
        ),
      ];
    case "source-contract":
      return [
        field("sourceOwner", "Owner", profile.sourceContract.owner, "text", disabled, true),
        field("sourceRepository", "Repository", profile.sourceContract.repository ?? "", "text", disabled),
        field("sourceCommit", "Commit", profile.sourceContract.commit ?? "", "text", disabled),
        field("sourceDocumentPath", "Document path", profile.sourceContract.documentPath, "text", disabled, true),
        field(
          "fixtureSetVersion",
          "Fixture set version",
          profile.sourceContract.fixtureSetVersion,
          "text",
          disabled,
          true,
        ),
      ];
    case "fixtures":
      return [
        field("fixtureRoot", "Fixture root", profile.fixtures.fixtureRoot, "text", disabled, true),
        field("coveredFlows", "Covered flows", profile.fixtures.coveredFlows.join(", "), "tags", disabled),
        field(
          "liveProviderCallsAllowed",
          "Live provider calls",
          String(profile.fixtures.liveProviderCallsAllowed),
          "checkbox",
          true,
          false,
          "Offline fixture validation is required for launch.",
        ),
      ];
    case "source-observation":
      return [
        field(
          "observationIdPath",
          "Observation id source",
          expressionSummary(sourceObservation?.observationId),
          "text",
          disabled,
        ),
        field(
          "externalKeyPath",
          "External key source",
          expressionSummary(sourceObservation?.externalKey),
          "text",
          disabled,
        ),
        field("sourceUrlPath", "Source URL source", expressionSummary(sourceObservation?.sourceUrl), "text", disabled),
        field(
          "sourceUpdatedAtPath",
          "Source updated source",
          expressionSummary(sourceObservation?.sourceUpdatedAt),
          "text",
          disabled,
        ),
      ];
    case "normalized-observation":
      return [
        field(
          "normalizedOutputKind",
          "Output kind",
          stringValue(normalizedObservation?.outputKind) ?? profile.mappingOutputKind,
          "text",
          disabled,
          true,
        ),
        field(
          "normalizedLanguagePath",
          "Language source",
          expressionSummary(normalizedObservation?.languageCode),
          "text",
          disabled,
        ),
        field(
          "normalizedFieldCount",
          "Normalized field count",
          String(recordKeys(normalizedObservation?.fields).length),
          "text",
          true,
        ),
        field(
          "hashMaterialCount",
          "Hash material count",
          String(arrayValue(normalizedObservation?.hashMaterial).length),
          "text",
          true,
        ),
      ];
    case "external-references":
      return [
        field(
          "externalReferenceProviderKey",
          "Reference provider",
          stringValue(externalReferences?.providerKey) ?? "",
          "text",
          disabled,
        ),
        field(
          "externalReferenceTarget",
          "Reference target",
          stringValue(externalReferences?.target) ?? "",
          "text",
          disabled,
        ),
        field(
          "externalKeyPrefix",
          "External key prefix",
          stringValue(externalReferences?.externalKeyPrefix) ?? "",
          "text",
          disabled,
        ),
        field(
          "externalReferenceCount",
          "Reference contract count",
          String(arrayValue(contractRecord?.externalReferences).length),
          "text",
          true,
        ),
      ];
    case "selected-options":
      return [
        field(
          "selectedOptionDimensionKey",
          "Dimension key",
          stringValue(selectedOptionDimension?.dimensionKey) ?? "",
          "text",
          disabled,
        ),
        field(
          "selectedOptionSource",
          "Option source",
          stringValue(selectedOptions?.missingOrUnknownOptionPolicy) ??
            stringValue(selectedOptionMapping?.source) ??
            "",
          "text",
          disabled,
        ),
        field(
          "selectedOptionDimensionCount",
          "Dimension count",
          String(arrayValue(selectedOptionMapping?.dimensions).length),
          "text",
          true,
        ),
      ];
    case "reference-hierarchy":
      return [
        field(
          "referenceHierarchyType",
          "Reference type",
          stringValue(referenceHierarchy?.targetTypeKey) ?? "",
          "text",
          disabled,
        ),
        field(
          "referenceHierarchyProviderAttribute",
          "Provider attribute",
          stringValue(referenceHierarchy?.providerAttributeKey) ??
            stringValue(referenceHierarchyMapping?.providerAttributeKey) ??
            "",
          "text",
          disabled,
        ),
        field(
          "referenceHierarchyContractCount",
          "Hierarchy contract count",
          String(arrayValue(contractRecord?.referenceHierarchy).length),
          "text",
          true,
        ),
      ];
    case "duplicate-prevention":
      return [
        field(
          "exactExternalCatalogItemReferencesFirst",
          "Check external references first",
          String(booleanValue(duplicatePrevention?.exactExternalCatalogItemReferencesFirst) ?? false),
          "checkbox",
          disabled,
        ),
        field(
          "ambiguousCandidatePolicy",
          "Ambiguous candidate policy",
          stringValue(duplicatePrevention?.ambiguousCandidatePolicy) ?? "",
          "select",
          disabled,
          true,
          null,
          [option("block-promotion", "Block promotion"), option("review-only", "Review only")],
        ),
        field(
          "replayPolicy",
          "Replay policy",
          stringValue(duplicatePrevention?.replayPolicy) ?? "",
          "select",
          disabled,
          true,
          null,
          [
            option("same-profile-version", "Same profile version"),
            option("operator-reapply-active-version", "Operator reapply active version"),
          ],
        ),
        field(
          "duplicatePreventionMappingSource",
          "Mapping source",
          stringValue(duplicatePreventionMapping?.source) ?? "",
          "text",
          disabled,
        ),
      ];
    case "promotion-plan":
      return [
        field(
          "promotionPlanKind",
          "Plan kind",
          stringValue(promotionCommandPlan?.planKind) ?? "",
          "text",
          disabled,
          true,
        ),
        field(
          "promotionRequiresReview",
          "Requires review",
          String(booleanValue(promotionCommandPlan?.requiresReview) ?? true),
          "checkbox",
          true,
        ),
        field(
          "promotionCommandCount",
          "Command count",
          String(arrayValue(promotionCommandPlan?.commands).length),
          "text",
          true,
        ),
      ];
    case "retirement-plan":
      return [
        field(
          "retirementTrackingIssue",
          "Tracking issue",
          numberString(retirementPlan?.trackingIssue),
          "text",
          disabled,
        ),
        field("retirementReason", "Removal reason", stringValue(retirementPlan?.reason) ?? "", "textarea", disabled),
      ];
    case "migration-evidence":
      return [
        field("migrationEvidenceText", "Evidence", profile.migrationEvidence?.evidenceText ?? "", "textarea", disabled),
        field("migrationFixtureRunId", "Fixture run", profile.migrationEvidence?.fixtureRunId ?? "", "text", disabled),
        field(
          "migrationFingerprintBefore",
          "Mapping fingerprint before",
          profile.migrationEvidence?.mappingFingerprintBefore ?? "",
          "text",
          disabled,
        ),
        field(
          "migrationFingerprintAfter",
          "Mapping fingerprint after",
          profile.migrationEvidence?.mappingFingerprintAfter ?? "",
          "text",
          disabled,
        ),
        field("migrationRecordedAt", "Recorded at", profile.migrationEvidence?.recordedAt ?? "", "text", disabled),
      ];
  }
}

function field(
  key: string,
  label: string,
  value: string,
  control: ProfileSectionField["control"],
  disabled: boolean,
  required = false,
  helpText: string | null = null,
  options: readonly ProfileSectionField["options"][number][] = [],
): ProfileSectionField {
  return { key, label, value, control, required, disabled, helpText, options };
}

function option(value: string, label: string): ProfileSectionField["options"][number] {
  return { value, label };
}
