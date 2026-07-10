import type { JsonObject } from "@chase-sets/primitives/json";
import { CatalogApiError } from "../../../client";
import type { CatalogProviderProfileVersionReview } from "../../../client";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileEditableSectionKey,
  CatalogProviderProfileSectionUpdateCommand,
} from "../../../features/source-observations/ui/contracts";
import type { createCatalogRequestApiClient } from "../../../support/request-support/api-client";
import type { CatalogPrimaryWorkbenchCommandFeedback } from "../../../features/source-observations/ui/primary-workbench-command-feedback";
import {
  arrayValue,
  jsonRecord,
  listValue,
  mutableLifecycleValue,
  nullableStringValue,
  numberValue,
  profileStatusValue,
  recordValue,
  stringArrayValue,
  stringValue,
} from "./integrations-form-values";

export async function profileSectionCommandFromFormData(
  api: ReturnType<typeof createCatalogRequestApiClient>,
  input: Readonly<{
    providerKey: string;
    profileVersion: string;
    sectionKey: CatalogProviderProfileEditableSectionKey;
    formData: FormData;
  }>,
): Promise<CatalogProviderProfileSectionUpdateCommand> {
  // Fetch only the targeted profile version (via its authoring model) instead of
  // re-listing every provider profile just to find one row. The authoring model
  // carries the same CatalogProviderProfileVersionReview the section command
  // needs.
  const authoringModel =
    await api.getSourceObservationProviderProfileAuthoringModel<CatalogProviderProfileAuthoringModel>(
      input.providerKey,
      input.profileVersion,
    );
  const profile = authoringModel.review;
  if (!profile || profile.providerKey !== input.providerKey || profile.profileVersion !== input.profileVersion) {
    throw new Error("Profile version missing.");
  }

  return profileSectionCommand(profile, input.sectionKey, input.formData);
}

function profileSectionCommand(
  profile: CatalogProviderProfileVersionReview,
  sectionKey: CatalogProviderProfileEditableSectionKey,
  formData: FormData,
): CatalogProviderProfileSectionUpdateCommand {
  const profileRecord = recordValue(profile.profile);
  const contractRecord = recordValue(profile.executableMappingContract);

  switch (sectionKey) {
    case "basics":
      return {
        section: "basics",
        displayName: stringValue(formData.get("displayName")) ?? profile.displayName,
        lifecycle: mutableLifecycleValue(formData.get("lifecycle")),
        status: profileStatusValue(formData.get("status")) ?? (profile.status === "active" ? "active" : "planned"),
        capabilities: listValue(formData.get("capabilities"), profile.capabilities),
        supportedScopes: listValue(formData.get("supportedScopes"), profile.supportedScopes),
        languageOptions: listValue(formData.get("languageOptions"), profile.languageOptions),
      };
    case "provider-options": {
      const optionQueries = [...arrayValue(profileRecord?.optionQueries)];
      const index = Math.max(0, Number.parseInt(stringValue(formData.get("optionQueryIndex")) ?? "0", 10) || 0);
      const existing = recordValue(optionQueries[index]) ?? {};
      if (optionQueries.length > 0) {
        optionQueries[index] = {
          ...existing,
          displayName: stringValue(formData.get("optionQueryDisplayName")) ?? stringValue(existing.displayName) ?? "",
          scope: stringValue(formData.get("optionQueryScope")) ?? stringValue(existing.scope) ?? "",
          operation: stringValue(formData.get("optionQueryOperation")) ?? stringValue(existing.operation) ?? "",
        };
      }

      return { section: "provider-options", optionQueries: optionQueries.map(jsonRecord) };
    }
    case "connector": {
      const connector: Record<string, unknown> = {
        ...(recordValue(profileRecord?.connector) ?? {}),
        kind: stringValue(formData.get("connectorKind")) ?? profile.connectorKind,
      };
      const connectorBaseUrl = stringValue(formData.get("connectorBaseUrl"));
      if (connectorBaseUrl) {
        connector.baseUrl = connectorBaseUrl;
      }

      return {
        section: "connector",
        connector: connector as JsonObject,
        mappingConnector: {
          ...(recordValue(contractRecord?.connector) ?? {}),
          kind:
            stringValue(formData.get("connectorKind")) ??
            stringValue(recordValue(contractRecord?.connector)?.kind) ??
            profile.connectorKind,
          transportOwns: listValue(
            formData.get("connectorTransportOwns"),
            stringArrayValue(recordValue(contractRecord?.connector)?.transportOwns),
          ),
          mappingOwns: listValue(
            formData.get("connectorMappingOwns"),
            stringArrayValue(recordValue(contractRecord?.connector)?.mappingOwns),
          ),
        } as JsonObject,
      };
    }
    case "catalog-field-mapping":
      return {
        section: "catalog-field-mapping",
        catalogFieldMapping: {
          ...(recordValue(profileRecord?.catalogFieldMapping) ?? {}),
          blueprintKey:
            stringValue(formData.get("blueprintKey")) ??
            stringValue(recordValue(profileRecord?.catalogFieldMapping)?.blueprintKey) ??
            "",
          categoryKey:
            stringValue(formData.get("categoryKey")) ??
            stringValue(recordValue(profileRecord?.catalogFieldMapping)?.categoryKey) ??
            "",
        } as JsonObject,
      };
    case "source-contract":
      return {
        section: "source-contract",
        sourceContract: {
          owner: stringValue(formData.get("sourceOwner")) ?? profile.sourceContract.owner,
          repository: nullableStringValue(formData.get("sourceRepository"), profile.sourceContract.repository),
          commit: nullableStringValue(formData.get("sourceCommit"), profile.sourceContract.commit),
          documentPath: stringValue(formData.get("sourceDocumentPath")) ?? profile.sourceContract.documentPath,
          fixtureSetVersion: stringValue(formData.get("fixtureSetVersion")) ?? profile.sourceContract.fixtureSetVersion,
        },
      };
    case "fixtures":
      return {
        section: "fixtures",
        fixtures: {
          fixtureRoot: stringValue(formData.get("fixtureRoot")) ?? profile.fixtures.fixtureRoot,
          coveredFlows: listValue(formData.get("coveredFlows"), profile.fixtures.coveredFlows),
          liveProviderCallsAllowed: false,
        },
      };
    case "source-observation": {
      const sourceObservation = recordValue(contractRecord?.sourceObservation);
      return {
        section: "source-observation",
        sourceObservation: sourceObservation
          ? ({
              ...sourceObservation,
              observationId: expressionWithPath(sourceObservation.observationId, formData.get("observationIdPath")),
              externalKey: expressionWithPath(sourceObservation.externalKey, formData.get("externalKeyPath")),
              sourceUrl: expressionWithPath(sourceObservation.sourceUrl, formData.get("sourceUrlPath")),
              sourceUpdatedAt: expressionWithPath(
                sourceObservation.sourceUpdatedAt,
                formData.get("sourceUpdatedAtPath"),
              ),
            } as JsonObject)
          : null,
      };
    }
    case "normalized-observation": {
      const normalizedObservation = recordValue(contractRecord?.normalizedObservation) ?? {};
      return {
        section: "normalized-observation",
        normalizedObservationContract: {
          ...normalizedObservation,
          outputKind:
            stringValue(formData.get("normalizedOutputKind")) ??
            stringValue(normalizedObservation.outputKind) ??
            profile.mappingOutputKind,
          languageCode: expressionWithPath(normalizedObservation.languageCode, formData.get("normalizedLanguagePath")),
        } as JsonObject,
      };
    }
    case "external-references": {
      const contracts = [...arrayValue(contractRecord?.externalReferences)];
      const first = recordValue(contracts[0]) ?? {};
      contracts[0] = {
        ...first,
        providerKey:
          stringValue(formData.get("externalReferenceProviderKey")) ??
          stringValue(first.providerKey) ??
          profile.providerKey,
        target:
          stringValue(formData.get("externalReferenceTarget")) ?? stringValue(first.target) ?? "catalog-item-reference",
        externalKeyPrefix: stringValue(formData.get("externalKeyPrefix")) ?? stringValue(first.externalKeyPrefix) ?? "",
      };

      return {
        section: "external-references",
        externalReferenceExtractionRules: (recordValue(profileRecord?.externalReferenceExtractionRules) ??
          {}) as JsonObject,
        externalReferenceContracts: contracts.map(jsonRecord),
      };
    }
    case "selected-options": {
      const selectedOptionMapping = recordValue(profileRecord?.selectedOptionMapping);
      if (!selectedOptionMapping) {
        return { section: "selected-options", selectedOptionMapping: null };
      }
      const dimensions = [...arrayValue(selectedOptionMapping.dimensions)];
      const firstDimension = recordValue(dimensions[0]) ?? {};
      if (dimensions.length > 0) {
        dimensions[0] = {
          ...firstDimension,
          dimensionKey:
            stringValue(formData.get("selectedOptionDimensionKey")) ?? stringValue(firstDimension.dimensionKey) ?? "",
        };
      }

      return {
        section: "selected-options",
        selectedOptionMapping: {
          ...selectedOptionMapping,
          dimensions: dimensions.map(jsonRecord),
        } as JsonObject,
      };
    }
    case "reference-hierarchy": {
      const contracts = [...arrayValue(contractRecord?.referenceHierarchy)];
      const first = recordValue(contracts[0]) ?? {};
      if (contracts.length > 0) {
        contracts[0] = {
          ...first,
          targetTypeKey: stringValue(formData.get("referenceHierarchyType")) ?? stringValue(first.targetTypeKey) ?? "",
          providerAttributeKey:
            stringValue(formData.get("referenceHierarchyProviderAttribute")) ??
            stringValue(first.providerAttributeKey) ??
            "",
        };
      }

      return {
        section: "reference-hierarchy",
        referenceHierarchyMapping: (recordValue(profileRecord?.referenceHierarchyMapping) ?? {}) as JsonObject,
        referenceHierarchyContracts: contracts.map(jsonRecord),
      };
    }
    case "duplicate-prevention": {
      const duplicatePrevention = recordValue(contractRecord?.duplicatePrevention) ?? {};
      return {
        section: "duplicate-prevention",
        duplicatePreventionMapping: (recordValue(profileRecord?.duplicatePreventionMapping) ?? {}) as JsonObject,
        ambiguityRules: (recordValue(profileRecord?.ambiguityRules) ?? {}) as JsonObject,
        duplicatePreventionContract: {
          ...duplicatePrevention,
          exactExternalCatalogItemReferencesFirst:
            formData.get("exactExternalCatalogItemReferencesFirst") === "on" ||
            formData.get("exactExternalCatalogItemReferencesFirst") === "true",
          ambiguousCandidatePolicy:
            stringValue(formData.get("ambiguousCandidatePolicy")) ??
            stringValue(duplicatePrevention.ambiguousCandidatePolicy) ??
            "review-only",
          replayPolicy:
            stringValue(formData.get("replayPolicy")) ??
            stringValue(duplicatePrevention.replayPolicy) ??
            "same-profile-version",
        } as JsonObject,
      };
    }
    case "promotion-plan":
      return {
        section: "promotion-plan",
        promotionCommandPlan: {
          ...(recordValue(contractRecord?.promotionCommandPlan) ?? {}),
          planKind: stringValue(formData.get("promotionPlanKind")) ?? "catalog-item-promotion",
          requiresReview: true,
        } as JsonObject,
      };
    case "retirement-plan": {
      const trackingIssue = numberValue(formData.get("retirementTrackingIssue"));
      const diagnosticText = stringValue(formData.get("retirementReason"));
      if (trackingIssue === null && !diagnosticText) {
        return { section: "retirement-plan", retirementPlan: null };
      }

      return {
        section: "retirement-plan",
        retirementPlan: {
          ...(recordValue(profile.retirementPlan) ?? {}),
          trackingIssue: trackingIssue ?? numberValue(recordValue(profile.retirementPlan)?.trackingIssue) ?? 0,
          removeAfter: "executable-mapping-contract-activated",
          diagnosticText:
            diagnosticText ??
            stringValue(recordValue(profile.retirementPlan)?.diagnosticText) ??
            "Remove retired profile completely before launch.",
        },
      };
    }
    case "migration-evidence":
      return {
        section: "migration-evidence",
        migrationEvidence: {
          ...(profile.migrationEvidence ?? {}),
          evidenceText:
            stringValue(formData.get("migrationEvidenceText")) ??
            profile.migrationEvidence?.evidenceText ??
            "Section update validated through profile authoring.",
          fixtureRunId: nullableStringValue(
            formData.get("migrationFixtureRunId"),
            profile.migrationEvidence?.fixtureRunId ?? null,
          ),
          mappingFingerprintBefore: nullableStringValue(
            formData.get("migrationFingerprintBefore"),
            profile.migrationEvidence?.mappingFingerprintBefore ?? null,
          ),
          mappingFingerprintAfter: nullableStringValue(
            formData.get("migrationFingerprintAfter"),
            profile.migrationEvidence?.mappingFingerprintAfter ?? null,
          ),
          recordedAt:
            stringValue(formData.get("migrationRecordedAt")) ??
            profile.migrationEvidence?.recordedAt ??
            new Date(0).toISOString(),
        },
      };
  }
}

export function editableProfileSectionKey(value: string | null): CatalogProviderProfileEditableSectionKey | null {
  switch (value) {
    case "basics":
    case "provider-options":
    case "connector":
    case "catalog-field-mapping":
    case "source-contract":
    case "fixtures":
    case "source-observation":
    case "normalized-observation":
    case "external-references":
    case "selected-options":
    case "reference-hierarchy":
    case "duplicate-prevention":
    case "promotion-plan":
    case "retirement-plan":
    case "migration-evidence":
      return value;
    default:
      return null;
  }
}

export function profileSectionFailureResult(
  error: unknown,
): Extract<
  CatalogPrimaryWorkbenchCommandFeedback["result"],
  "section-conflict" | "section-invalid" | "command-failed"
> {
  if (error instanceof CatalogApiError) {
    if (error.status === 409) {
      return "section-conflict";
    }
    if (error.status === 400) {
      return "section-invalid";
    }
  }

  return "command-failed";
}

function expressionWithPath(value: unknown, pathValue: FormDataEntryValue | unknown): JsonObject {
  const expression = recordValue(value) ?? {
    owner: "catalog-truth",
    uses: ["source-payload"],
    redaction: "none",
  };
  const selector = recordValue(expression.selector) ?? {
    kind: "path",
    required: true,
    nullPolicy: "diagnostic",
  };
  const path = stringValue(pathValue) ?? stringValue(selector.path) ?? "";

  return {
    ...expression,
    selector: {
      ...selector,
      kind: "path",
      path,
    },
  } as JsonObject;
}
