import type { CatalogProviderProfileEditableSectionKey } from "../api/provider-profile-section-registry";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import type { CatalogProviderProfileVersionReview } from "./contracts";
import {
  arrayValue,
  compactMappingSummary,
  expressionSummary,
  recordValue,
  stringArrayValue,
  stringValue,
} from "./primary-workbench-read-model-support";

export type ProfileMappingRow =
  CatalogPrimaryWorkbenchReadModel["profileAuthoring"]["sectionWorkspaces"][number]["mappingRows"][number];

export function profileSectionMappingRows(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
): readonly ProfileMappingRow[] {
  const profileRecord = recordValue(profile.profile);
  const contractRecord = recordValue(profile.executableMappingContract);
  const rows: ProfileMappingRow[] = [];

  switch (section) {
    case "catalog-field-mapping": {
      const catalogFieldMapping = recordValue(profileRecord?.catalogFieldMapping);
      const fieldKeys = recordValue(catalogFieldMapping?.fieldKeys);
      addMappingRecordRow(
        rows,
        "catalog-field-mapping.blueprint",
        "Blueprint key",
        "profile.catalogFieldMapping.blueprintKey",
        catalogFieldMapping?.blueprintKey,
        diagnostics,
      );
      addMappingRecordRow(
        rows,
        "catalog-field-mapping.category",
        "Category key",
        "profile.catalogFieldMapping.categoryKey",
        catalogFieldMapping?.categoryKey,
        diagnostics,
      );
      for (const [fieldKey, expression] of Object.entries(fieldKeys ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        addMappingExpressionRow(
          rows,
          `catalog-field-mapping.field.${fieldKey}`,
          `Catalog field: ${fieldKey}`,
          `profile.catalogFieldMapping.fieldKeys.${fieldKey}`,
          expression,
          diagnostics,
        );
      }
      break;
    }
    case "source-observation": {
      const sourceObservation = recordValue(contractRecord?.sourceObservation);
      for (const key of ["observationId", "externalKey", "sourceUrl", "sourceUpdatedAt", "sourcePayload"]) {
        addMappingExpressionRow(
          rows,
          `source-observation.${key}`,
          sourceObservationLabel(key),
          `executableMappingContract.sourceObservation.${key}`,
          sourceObservation?.[key],
          diagnostics,
        );
      }
      break;
    }
    case "normalized-observation": {
      const normalizedObservation = recordValue(contractRecord?.normalizedObservation);
      addMappingExpressionRow(
        rows,
        "normalized-observation.languageCode",
        "Language code",
        "executableMappingContract.normalizedObservation.languageCode",
        normalizedObservation?.languageCode,
        diagnostics,
      );
      for (const [fieldKey, expression] of Object.entries(recordValue(normalizedObservation?.fields) ?? {}).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        addMappingExpressionRow(
          rows,
          `normalized-observation.field.${fieldKey}`,
          `Normalized field: ${fieldKey}`,
          `executableMappingContract.normalizedObservation.fields.${fieldKey}`,
          expression,
          diagnostics,
        );
      }
      for (const [index, expression] of arrayValue(normalizedObservation?.hashMaterial).entries()) {
        addMappingExpressionRow(
          rows,
          `normalized-observation.hashMaterial.${index}`,
          `Hash material ${index + 1}`,
          `executableMappingContract.normalizedObservation.hashMaterial.${index}`,
          expression,
          diagnostics,
          true,
        );
      }
      for (const [index, expression] of arrayValue(normalizedObservation?.mergeIdentity).entries()) {
        addMappingExpressionRow(
          rows,
          `normalized-observation.mergeIdentity.${index}`,
          `Merge identity ${index + 1}`,
          `executableMappingContract.normalizedObservation.mergeIdentity.${index}`,
          expression,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "external-references": {
      for (const [index, reference] of arrayValue(contractRecord?.externalReferences).entries()) {
        const record = recordValue(reference);
        addMappingExpressionRow(
          rows,
          `external-references.${index}.source`,
          `${stringValue(record?.providerKey) ?? "External"} ${stringValue(record?.target) ?? "reference"}`,
          `executableMappingContract.externalReferences.${index}.source`,
          record?.source,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "selected-options": {
      for (const [referenceIndex, reference] of arrayValue(contractRecord?.externalReferences).entries()) {
        const selectedOptions = recordValue(recordValue(reference)?.selectedOptions);
        for (const [dimensionIndex, dimension] of arrayValue(selectedOptions?.dimensions).entries()) {
          const record = recordValue(dimension);
          addMappingExpressionRow(
            rows,
            `selected-options.${referenceIndex}.${dimensionIndex}`,
            `Selected option: ${stringValue(record?.dimensionKey) ?? `dimension ${dimensionIndex + 1}`}`,
            `executableMappingContract.externalReferences.${referenceIndex}.selectedOptions.dimensions.${dimensionIndex}.providerValue`,
            record?.providerValue,
            diagnostics,
            true,
          );
        }
      }
      const selectedOptionMapping = recordValue(profileRecord?.selectedOptionMapping);
      for (const [index, dimension] of arrayValue(selectedOptionMapping?.dimensions).entries()) {
        const record = recordValue(dimension);
        addMappingRecordRow(
          rows,
          `selected-option-mapping.${index}`,
          `Option dimension: ${stringValue(record?.dimensionKey) ?? index + 1}`,
          `profile.selectedOptionMapping.dimensions.${index}`,
          record?.sourcePath ?? record?.providerValuePath ?? record?.optionLookupTableKey,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "reference-hierarchy": {
      for (const [index, hierarchy] of arrayValue(contractRecord?.referenceHierarchy).entries()) {
        addReferenceHierarchyRows(
          rows,
          hierarchy,
          `executableMappingContract.referenceHierarchy.${index}`,
          diagnostics,
        );
      }
      break;
    }
    case "duplicate-prevention": {
      const duplicatePrevention = recordValue(contractRecord?.duplicatePrevention);
      for (const [index, expression] of arrayValue(duplicatePrevention?.mergeCandidateEvidence).entries()) {
        addMappingExpressionRow(
          rows,
          `duplicate-prevention.mergeCandidateEvidence.${index}`,
          `Merge evidence ${index + 1}`,
          `executableMappingContract.duplicatePrevention.mergeCandidateEvidence.${index}`,
          expression,
          diagnostics,
          true,
        );
      }
      for (const [ruleIndex, rule] of arrayValue(duplicatePrevention?.identityRules).entries()) {
        const record = recordValue(rule);
        for (const [evidenceIndex, expression] of arrayValue(record?.evidence).entries()) {
          addMappingExpressionRow(
            rows,
            `duplicate-prevention.identityRules.${ruleIndex}.${evidenceIndex}`,
            `${stringValue(record?.ruleKey) ?? `Rule ${ruleIndex + 1}`} evidence ${evidenceIndex + 1}`,
            `executableMappingContract.duplicatePrevention.identityRules.${ruleIndex}.evidence.${evidenceIndex}`,
            expression,
            diagnostics,
            true,
          );
        }
      }
      for (const [index, rule] of arrayValue(recordValue(profileRecord?.duplicatePreventionMapping)?.rules).entries()) {
        const record = recordValue(rule);
        addMappingRecordRow(
          rows,
          `duplicate-prevention.mapping.${index}`,
          `Duplicate rule: ${stringValue(record?.ruleKey) ?? index + 1}`,
          `profile.duplicatePreventionMapping.rules.${index}`,
          record?.sourcePath ?? record?.matchKind,
          diagnostics,
          true,
        );
      }
      break;
    }
    case "promotion-plan": {
      const promotionCommandPlan = recordValue(contractRecord?.promotionCommandPlan);
      for (const [commandIndex, command] of arrayValue(promotionCommandPlan?.commands).entries()) {
        const commandRecord = recordValue(command);
        for (const [inputKey, expression] of Object.entries(recordValue(commandRecord?.inputs) ?? {}).sort(
          ([left], [right]) => left.localeCompare(right),
        )) {
          addMappingExpressionRow(
            rows,
            `promotion-plan.${commandIndex}.${inputKey}`,
            `${stringValue(commandRecord?.commandName) ?? `Command ${commandIndex + 1}`}: ${inputKey}`,
            `executableMappingContract.promotionCommandPlan.commands.${commandIndex}.inputs.${inputKey}`,
            expression,
            diagnostics,
            true,
          );
        }
      }
      break;
    }
    default:
      break;
  }

  return rows;
}

function addReferenceHierarchyRows(
  rows: ProfileMappingRow[],
  value: unknown,
  path: string,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
): void {
  const record = recordValue(value);
  if (!record) {
    return;
  }
  addMappingExpressionRow(
    rows,
    `reference-hierarchy.${path}.key`,
    `Reference hierarchy: ${stringValue(record.targetTypeKey) ?? "record"}`,
    `${path}.referenceRecordKey`,
    record.referenceRecordKey,
    diagnostics,
    true,
  );
  if (record.parent) {
    addReferenceHierarchyRows(rows, record.parent, `${path}.parent`, diagnostics);
  }
}

function addMappingExpressionRow(
  rows: ProfileMappingRow[],
  key: string,
  label: string,
  path: string,
  value: unknown,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
  listAffordances = false,
): void {
  const expression = recordValue(value);
  if (!expression) {
    return;
  }

  rows.push({
    key,
    label,
    path,
    summary: compactMappingSummary(expressionSummary(expression)),
    owner: stringValue(expression.owner),
    redaction: stringValue(expression.redaction),
    uses: stringArrayValue(expression.uses),
    diagnostics: diagnosticsForPath(diagnostics, path),
    previewAvailable: Boolean(recordValue(expression.selector)),
    affordances: {
      duplicate: listAffordances,
      reorder: listAffordances,
      remove: listAffordances,
      inlineDiagnostics: true,
      longPathSafe: true,
    },
  });
}

function addMappingRecordRow(
  rows: ProfileMappingRow[],
  key: string,
  label: string,
  path: string,
  value: unknown,
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
  listAffordances = false,
): void {
  const summary = value === undefined || value === null ? "" : typeof value === "string" ? value : String(value);
  if (!summary) {
    return;
  }

  rows.push({
    key,
    label,
    path,
    summary: compactMappingSummary(summary),
    owner: null,
    redaction: null,
    uses: [],
    diagnostics: diagnosticsForPath(diagnostics, path),
    previewAvailable: false,
    affordances: {
      duplicate: listAffordances,
      reorder: listAffordances,
      remove: listAffordances,
      inlineDiagnostics: true,
      longPathSafe: true,
    },
  });
}

function diagnosticsForPath(
  diagnostics: readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[],
  path: string,
): ProfileMappingRow["diagnostics"] {
  return diagnostics.filter((diagnostic) => diagnostic.path === path || diagnostic.path.startsWith(`${path}.`));
}

function sourceObservationLabel(key: string): string {
  switch (key) {
    case "observationId":
      return "Observation id";
    case "externalKey":
      return "External key";
    case "sourceUrl":
      return "Source URL";
    case "sourceUpdatedAt":
      return "Source updated";
    case "sourcePayload":
      return "Source payload";
    default:
      return key;
  }
}
