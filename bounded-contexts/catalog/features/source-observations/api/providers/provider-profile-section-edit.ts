import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import {
  type CatalogProviderProfileEditableSectionKey,
  type CatalogProviderProfileSectionUpdateCommand,
  CatalogProviderProfileSectionValidationError,
  getCatalogProviderProfileSectionDefinition,
} from "./provider-profile-section-registry";

/**
 * An operator's edit of one profile section: the section form's fields by name, as posted. A field
 * left out keeps its stored value, except a checkbox, which a form leaves out when it is unchecked.
 * Catalog composes the whole section over the stored version and applies its own defaults and fixed
 * values, so a client sends only what the operator can change.
 */
export type CatalogProviderProfileSectionEdit = Readonly<{
  section: CatalogProviderProfileEditableSectionKey;
  fields: Readonly<Record<string, string>>;
}>;

export type CatalogProviderProfileSectionFieldControl = "text" | "textarea" | "select" | "checkbox" | "tags";

/**
 * One field of a section's form, as Catalog defines it. `defaultValue` is what Catalog stores when
 * neither the edit nor the stored section has a value. A field with a `fixedValue` always has that
 * value: a form shows it read-only and does not send it, and an edit that does must send that value.
 * `options` lists a select's fixed choices; a select whose choices come from the stored version (the
 * option query index) lists none here.
 */
export type CatalogProviderProfileSectionField = Readonly<{
  key: string;
  label: string;
  control: CatalogProviderProfileSectionFieldControl;
  required: boolean;
  options: readonly Readonly<{ value: string; label: string }>[];
  defaultValue: string | null;
  fixedValue: string | null;
  helpText: string | null;
}>;

// Catalog's defaults for a value neither the edit nor the stored section has.
const defaultPromotionPlanKind = "catalog-item-promotion";
const defaultExternalReferenceTarget = "catalog-item-reference";
const defaultAmbiguousCandidatePolicy = "review-only";
const defaultReplayPolicy = "same-profile-version";
const defaultRetirementRemoveAfter = "executable-mapping-contract-activated";
const defaultRetirementDiagnosticText = "Remove retired profile completely before launch.";

/** Each section's form fields, in form order: what an operator edits and what Catalog fixes. */
export const catalogProviderProfileSectionFields: Readonly<
  Record<CatalogProviderProfileEditableSectionKey, readonly CatalogProviderProfileSectionField[]>
> = {
  basics: [
    sectionField("displayName", "Display name", "text", { required: true }),
    sectionField("lifecycle", "Lifecycle", "select", {
      required: true,
      options: [choice("draft", "Draft"), choice("test", "Test")],
    }),
    sectionField("status", "Status", "select", {
      required: true,
      options: [choice("active", "Active"), choice("planned", "Planned")],
    }),
    sectionField("capabilities", "Capabilities", "tags"),
    sectionField("supportedScopes", "Supported scopes", "tags"),
    sectionField("languageOptions", "Languages", "tags"),
  ],
  "provider-options": [
    sectionField("optionQueryIndex", "Option query", "select", { required: true }),
    sectionField("optionQueryDisplayName", "Option label", "text"),
    sectionField("optionQueryScope", "Scope", "text"),
    sectionField("optionQueryOperation", "Operation", "text"),
  ],
  connector: [
    sectionField("connectorKind", "Connector kind", "text", { required: true }),
    sectionField("connectorBaseUrl", "Base URL", "text"),
    sectionField("connectorTransportOwns", "Transport responsibilities", "tags"),
    sectionField("connectorMappingOwns", "Mapping responsibilities", "tags"),
  ],
  "catalog-field-mapping": [
    sectionField("blueprintKey", "Blueprint key", "text"),
    sectionField("categoryKey", "Category key", "text"),
  ],
  "source-contract": [
    sectionField("sourceOwner", "Owner", "text", { required: true }),
    sectionField("sourceRepository", "Repository", "text"),
    sectionField("sourceCommit", "Commit", "text"),
    sectionField("sourceDocumentPath", "Document path", "text", { required: true }),
    sectionField("fixtureSetVersion", "Fixture set version", "text", { required: true }),
  ],
  fixtures: [
    sectionField("fixtureRoot", "Fixture root", "text", { required: true }),
    sectionField("coveredFlows", "Covered flows", "tags"),
    sectionField("liveProviderCallsAllowed", "Live provider calls", "checkbox", {
      fixedValue: "false",
      helpText: "Offline fixture validation is required for launch.",
    }),
  ],
  "source-observation": [
    sectionField("observationIdPath", "Observation id source", "text"),
    sectionField("externalKeyPath", "External key source", "text"),
    sectionField("sourceUrlPath", "Source URL source", "text"),
    sectionField("sourceUpdatedAtPath", "Source updated source", "text"),
  ],
  "normalized-observation": [
    sectionField("normalizedOutputKind", "Output kind", "text", { required: true }),
    sectionField("normalizedLanguagePath", "Language source", "text"),
  ],
  "external-references": [
    sectionField("externalReferenceProviderKey", "Reference provider", "text"),
    sectionField("externalReferenceTarget", "Reference target", "text", {
      defaultValue: defaultExternalReferenceTarget,
    }),
    sectionField("externalKeyPrefix", "External key prefix", "text"),
  ],
  "selected-options": [sectionField("selectedOptionDimensionKey", "Dimension key", "text")],
  "reference-hierarchy": [
    sectionField("referenceHierarchyType", "Reference type", "text"),
    sectionField("referenceHierarchyProviderAttribute", "Provider attribute", "text"),
  ],
  "duplicate-prevention": [
    sectionField("exactExternalCatalogItemReferencesFirst", "Check external references first", "checkbox"),
    sectionField("ambiguousCandidatePolicy", "Ambiguous candidate policy", "select", {
      required: true,
      options: [choice("block-promotion", "Block promotion"), choice("review-only", "Review only")],
      defaultValue: defaultAmbiguousCandidatePolicy,
    }),
    sectionField("replayPolicy", "Replay policy", "select", {
      required: true,
      options: [
        choice("same-profile-version", "Same profile version"),
        choice("operator-reapply-active-version", "Operator reapply active version"),
      ],
      defaultValue: defaultReplayPolicy,
    }),
  ],
  "promotion-plan": [
    sectionField("promotionPlanKind", "Plan kind", "text", { required: true, defaultValue: defaultPromotionPlanKind }),
    sectionField("promotionRequiresReview", "Requires review", "checkbox", { fixedValue: "true" }),
  ],
  "retirement-plan": [
    sectionField("retirementTrackingIssue", "Tracking issue", "text"),
    sectionField("retirementReason", "Removal reason", "textarea", { defaultValue: defaultRetirementDiagnosticText }),
  ],
  "migration-evidence": [
    sectionField("migrationEvidenceText", "Evidence", "textarea"),
    sectionField("migrationFixtureRunId", "Fixture run", "text"),
  ],
};

/** The fields each section's edit takes, by the names its form gives them. */
export const catalogProviderProfileSectionFieldKeys: Readonly<
  Record<CatalogProviderProfileEditableSectionKey, readonly string[]>
> = Object.fromEntries(
  Object.entries(catalogProviderProfileSectionFields).map(([section, fields]) => [
    section,
    fields.filter((field) => field.fixedValue === null).map((field) => field.key),
  ]),
) as Record<CatalogProviderProfileEditableSectionKey, readonly string[]>;

function sectionField(
  key: string,
  label: string,
  control: CatalogProviderProfileSectionFieldControl,
  rest: Partial<Omit<CatalogProviderProfileSectionField, "key" | "label" | "control">> = {},
): CatalogProviderProfileSectionField {
  return {
    key,
    label,
    control,
    required: rest.required ?? false,
    options: rest.options ?? [],
    defaultValue: rest.defaultValue ?? null,
    fixedValue: rest.fixedValue ?? null,
    helpText: rest.helpText ?? null,
  };
}

function choice(value: string, label: string): Readonly<{ value: string; label: string }> {
  return { value, label };
}
const defaultPathExpression = { owner: "catalog-truth", uses: ["source-payload"], redaction: "none" } as const;
const defaultPathSelector = { kind: "path", required: true, nullPolicy: "diagnostic" } as const;

/** Reads a request body's `fields` as the edit of `section`, refusing a field the section does not take. */
export function parseCatalogProviderProfileSectionEdit(
  value: unknown,
  section: string,
): CatalogProviderProfileSectionEdit {
  const definition = getCatalogProviderProfileSectionDefinition(section);
  if (!definition) {
    throw new CatalogProviderProfileSectionValidationError("Unsupported profile section update command.");
  }
  if (!isRecord(value)) {
    throw new CatalogProviderProfileSectionValidationError("fields must be a JSON object of the section's fields.");
  }
  const allowed: readonly string[] = catalogProviderProfileSectionFieldKeys[definition.section];
  const fixed = Object.fromEntries(
    catalogProviderProfileSectionFields[definition.section].flatMap((field) =>
      field.fixedValue === null ? [] : [[field.key, field.fixedValue] as const],
    ),
  );
  const fields: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new CatalogProviderProfileSectionValidationError(`fields.${key} must be a string.`);
    }
    const fixedValue = fixed[key];
    if (fixedValue !== undefined) {
      if (entry.trim() !== fixedValue) {
        throw new CatalogProviderProfileSectionValidationError(`fields.${key} must remain ${fixedValue}.`);
      }
      continue;
    }
    if (!allowed.includes(key)) {
      throw new CatalogProviderProfileSectionValidationError(
        `Profile section '${definition.section}' has no field '${key}'.`,
      );
    }
    fields[key] = entry;
  }

  return { section: definition.section, fields };
}

export function isCatalogProviderProfileSectionEdit(
  value: CatalogProviderProfileSectionUpdateCommand | CatalogProviderProfileSectionEdit,
): value is CatalogProviderProfileSectionEdit {
  return "fields" in value && isRecord(value.fields);
}

/** The whole section command an edit makes of the stored version: the edited fields over the stored ones. */
export function catalogProviderProfileSectionCommandFromEdit(
  version: CatalogProviderIntegrationProfileVersionRecord,
  edit: CatalogProviderProfileSectionEdit,
): CatalogProviderProfileSectionUpdateCommand {
  const posted = (key: string): string | null => textValue(edit.fields[key]);
  const profile = recordValue(version.profile) ?? {};
  const contract = recordValue(version.executableMappingContract);

  switch (edit.section) {
    case "basics": {
      const lifecycle = edit.fields.lifecycle;
      const status = edit.fields.status;
      return {
        section: "basics",
        // Not sent, the profile and its mapping contract keep their own names.
        displayName: posted("displayName") ?? undefined,
        lifecycle: lifecycle === "draft" || lifecycle === "test" ? lifecycle : undefined,
        status: status === "active" || status === "planned" ? status : version.profile.status,
        capabilities: listValue(edit.fields.capabilities, version.profile.capabilities),
        supportedScopes: listValue(edit.fields.supportedScopes, version.profile.supportedScopes),
        languageOptions: listValue(edit.fields.languageOptions, version.profile.languageOptions),
      };
    }
    case "provider-options": {
      const optionQueries = [...arrayValue(profile.optionQueries)];
      const index = Math.max(0, Number.parseInt(posted("optionQueryIndex") ?? "0", 10) || 0);
      const existing = recordValue(optionQueries[index]);
      if (existing) {
        optionQueries[index] = {
          ...existing,
          displayName: posted("optionQueryDisplayName") ?? textValue(existing.displayName) ?? "",
          scope: posted("optionQueryScope") ?? textValue(existing.scope) ?? "",
          operation: posted("optionQueryOperation") ?? textValue(existing.operation) ?? "",
        };
      }
      return { section: "provider-options", optionQueries: optionQueries.map(jsonObject) };
    }
    case "connector": {
      const storedConnector = recordValue(profile.connector) ?? {};
      const storedMapping = recordValue(contract?.connector) ?? {};
      const connector: Record<string, unknown> = {
        ...storedConnector,
        kind: posted("connectorKind") ?? version.profile.connector.kind,
      };
      const baseUrl = posted("connectorBaseUrl");
      if (baseUrl) {
        connector.baseUrl = baseUrl;
      }
      return {
        section: "connector",
        connector: connector as JsonObject,
        mappingConnector: {
          ...storedMapping,
          kind: posted("connectorKind") ?? textValue(storedMapping.kind) ?? version.profile.connector.kind,
          transportOwns: listValue(edit.fields.connectorTransportOwns, stringArray(storedMapping.transportOwns)),
          mappingOwns: listValue(edit.fields.connectorMappingOwns, stringArray(storedMapping.mappingOwns)),
        } as JsonObject,
      };
    }
    case "catalog-field-mapping": {
      const stored = recordValue(profile.catalogFieldMapping) ?? {};
      return {
        section: "catalog-field-mapping",
        catalogFieldMapping: {
          ...stored,
          blueprintKey: posted("blueprintKey") ?? textValue(stored.blueprintKey) ?? "",
          categoryKey: posted("categoryKey") ?? textValue(stored.categoryKey) ?? "",
        } as JsonObject,
      };
    }
    case "source-contract":
      return {
        section: "source-contract",
        sourceContract: {
          owner: posted("sourceOwner") ?? version.sourceContract.owner,
          repository: nullableText(edit.fields.sourceRepository, version.sourceContract.repository),
          commit: nullableText(edit.fields.sourceCommit, version.sourceContract.commit),
          documentPath: posted("sourceDocumentPath") ?? version.sourceContract.documentPath,
          fixtureSetVersion: posted("fixtureSetVersion") ?? version.sourceContract.fixtureSetVersion,
        },
      };
    case "fixtures":
      return {
        section: "fixtures",
        fixtures: {
          fixtureRoot: posted("fixtureRoot") ?? version.fixtures.fixtureRoot,
          coveredFlows: listValue(edit.fields.coveredFlows, version.fixtures.coveredFlows),
          liveProviderCallsAllowed: false,
        },
      };
    case "source-observation": {
      const stored = recordValue(contract?.sourceObservation);
      return {
        section: "source-observation",
        sourceObservation: stored
          ? ({
              ...stored,
              observationId: expressionWithPath(stored.observationId, edit.fields.observationIdPath),
              externalKey: expressionWithPath(stored.externalKey, edit.fields.externalKeyPath),
              sourceUrl: expressionWithPath(stored.sourceUrl, edit.fields.sourceUrlPath),
              sourceUpdatedAt: expressionWithPath(stored.sourceUpdatedAt, edit.fields.sourceUpdatedAtPath),
            } as JsonObject)
          : null,
      };
    }
    case "normalized-observation": {
      const stored = recordValue(contract?.normalizedObservation) ?? {};
      return {
        section: "normalized-observation",
        normalizedObservationContract: {
          ...stored,
          outputKind: posted("normalizedOutputKind") ?? textValue(stored.outputKind) ?? "unknown",
          languageCode: expressionWithPath(stored.languageCode, edit.fields.normalizedLanguagePath),
        } as JsonObject,
      };
    }
    case "external-references": {
      const contracts = [...arrayValue(contract?.externalReferences)];
      const first = recordValue(contracts[0]) ?? {};
      contracts[0] = {
        ...first,
        providerKey: posted("externalReferenceProviderKey") ?? textValue(first.providerKey) ?? version.providerKey,
        target: posted("externalReferenceTarget") ?? textValue(first.target) ?? defaultExternalReferenceTarget,
        externalKeyPrefix: posted("externalKeyPrefix") ?? textValue(first.externalKeyPrefix) ?? "",
      };
      return {
        section: "external-references",
        externalReferenceExtractionRules: jsonObject(profile.externalReferenceExtractionRules),
        externalReferenceContracts: contracts.map(jsonObject),
      };
    }
    case "selected-options": {
      const stored = recordValue(profile.selectedOptionMapping);
      if (!stored) {
        return { section: "selected-options", selectedOptionMapping: null };
      }
      const dimensions = [...arrayValue(stored.dimensions)];
      const firstDimension = recordValue(dimensions[0]);
      if (firstDimension) {
        dimensions[0] = {
          ...firstDimension,
          dimensionKey: posted("selectedOptionDimensionKey") ?? textValue(firstDimension.dimensionKey) ?? "",
        };
      }
      return {
        section: "selected-options",
        selectedOptionMapping: { ...stored, dimensions: dimensions.map(jsonObject) } as JsonObject,
      };
    }
    case "reference-hierarchy": {
      const contracts = [...arrayValue(contract?.referenceHierarchy)];
      const first = recordValue(contracts[0]);
      if (first) {
        contracts[0] = {
          ...first,
          targetTypeKey: posted("referenceHierarchyType") ?? textValue(first.targetTypeKey) ?? "",
          providerAttributeKey:
            posted("referenceHierarchyProviderAttribute") ?? textValue(first.providerAttributeKey) ?? "",
        };
      }
      return {
        section: "reference-hierarchy",
        referenceHierarchyMapping: jsonObject(profile.referenceHierarchyMapping),
        referenceHierarchyContracts: contracts.map(jsonObject),
      };
    }
    case "duplicate-prevention": {
      const stored = recordValue(contract?.duplicatePrevention) ?? {};
      const exact = edit.fields.exactExternalCatalogItemReferencesFirst;
      return {
        section: "duplicate-prevention",
        duplicatePreventionMapping: jsonObject(profile.duplicatePreventionMapping),
        ambiguityRules: jsonObject(profile.ambiguityRules),
        duplicatePreventionContract: {
          ...stored,
          exactExternalCatalogItemReferencesFirst: exact === "on" || exact === "true",
          ambiguousCandidatePolicy:
            posted("ambiguousCandidatePolicy") ??
            textValue(stored.ambiguousCandidatePolicy) ??
            defaultAmbiguousCandidatePolicy,
          replayPolicy: posted("replayPolicy") ?? textValue(stored.replayPolicy) ?? defaultReplayPolicy,
        } as JsonObject,
      };
    }
    case "promotion-plan": {
      const stored = recordValue(contract?.promotionCommandPlan) ?? {};
      return {
        section: "promotion-plan",
        promotionCommandPlan: {
          ...stored,
          planKind: posted("promotionPlanKind") ?? textValue(stored.planKind) ?? defaultPromotionPlanKind,
          requiresReview: true,
        } as JsonObject,
      };
    }
    case "retirement-plan": {
      const trackingIssue = numberValue(edit.fields.retirementTrackingIssue);
      const diagnosticText = posted("retirementReason");
      if (trackingIssue === null && !diagnosticText) {
        return { section: "retirement-plan", retirementPlan: null };
      }
      const stored = recordValue(version.retirementPlan) ?? {};
      return {
        section: "retirement-plan",
        retirementPlan: {
          ...(stored as JsonObject),
          trackingIssue: trackingIssue ?? numberValue(stored.trackingIssue) ?? 0,
          removeAfter: defaultRetirementRemoveAfter,
          diagnosticText: diagnosticText ?? textValue(stored.diagnosticText) ?? defaultRetirementDiagnosticText,
        },
      };
    }
    case "migration-evidence":
      // Only what the operator wrote; Catalog refuses a blank text and stamps the time, the
      // author and the fingerprints itself.
      return {
        section: "migration-evidence",
        migrationEvidence: {
          evidenceText: posted("migrationEvidenceText") ?? "",
          fixtureRunId: posted("migrationFixtureRunId"),
        },
      };
  }
}

// A value expression with the posted path. A path posted as the form showed it keeps the stored
// expression as it is, so saving a section leaves a template or constant selector alone.
function expressionWithPath(value: unknown, postedPath: string | undefined): JsonObject {
  const stored = recordValue(value);
  const path = textValue(postedPath);
  if (stored && (path === null || path === (expressionSummary(stored) || null))) {
    return stored as JsonObject;
  }
  const expression = stored ?? { ...defaultPathExpression };
  const selector = recordValue(expression.selector) ?? { ...defaultPathSelector };
  return {
    ...expression,
    selector: { ...selector, kind: "path", path: path ?? textValue(selector.path) ?? "" },
  } as JsonObject;
}

// What a section form shows for a value expression (the read model's `expressionSummary`).
function expressionSummary(expression: Record<string, unknown>): string {
  const selector = recordValue(expression.selector);
  switch (textValue(selector?.kind)) {
    case "path":
      return textValue(selector?.path) ?? "";
    case "template":
      return textValue(selector?.template) ?? "";
    case "constant": {
      const constant = selector?.value;
      return typeof constant === "string" ? constant : constant === undefined ? "" : String(constant);
    }
    case "named-runtime-selector":
      return textValue(selector?.functionKey) ?? "";
    default:
      return textValue(selector?.kind) ?? textValue(expression.owner) ?? "";
  }
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }
  return value.trim() || null;
}

function listValue<T extends string>(value: string | undefined, fallback: readonly T[]): readonly T[] {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? (parsed as T[]) : fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): readonly string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

function jsonObject(value: unknown): JsonObject {
  return (recordValue(value) ?? {}) as JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
