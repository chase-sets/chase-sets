import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";

export const catalogProviderProfileEditableSectionKeys = [
  "basics",
  "provider-options",
  "connector",
  "catalog-field-mapping",
  "source-contract",
  "fixtures",
  "source-observation",
  "normalized-observation",
  "external-references",
  "selected-options",
  "reference-hierarchy",
  "duplicate-prevention",
  "promotion-plan",
  "retirement-plan",
  "migration-evidence",
] as const;

export type CatalogProviderProfileEditableSectionKey = (typeof catalogProviderProfileEditableSectionKeys)[number];

export type CatalogProviderProfileBasicsUpdateCommand = Readonly<{
  section: "basics";
  lifecycle?: "draft" | "test";
  displayName?: string;
  status?: "active" | "planned";
  compatibilityMode?: "executable-mapping-contract" | "transitional-static-profile";
  capabilities?: readonly string[];
  supportedScopes?: readonly string[];
  languageOptions?: readonly string[];
}>;

export type CatalogProviderProfileSourceContractUpdateCommand = Readonly<{
  section: "source-contract";
  sourceContract: Readonly<{
    owner: string;
    repository: string | null;
    commit: string | null;
    documentPath: string;
    fixtureSetVersion: string;
  }>;
}>;

export type CatalogProviderProfileProviderOptionsUpdateCommand = Readonly<{
  section: "provider-options";
  optionQueries: readonly JsonObject[];
}>;

export type CatalogProviderProfileConnectorUpdateCommand = Readonly<{
  section: "connector";
  connector: JsonObject;
  mappingConnector?: JsonObject;
}>;

export type CatalogProviderProfileCatalogFieldMappingUpdateCommand = Readonly<{
  section: "catalog-field-mapping";
  catalogFieldMapping: JsonObject;
}>;

export type CatalogProviderProfileFixturesUpdateCommand = Readonly<{
  section: "fixtures";
  fixtures: Readonly<{
    fixtureRoot: string;
    coveredFlows: readonly string[];
    liveProviderCallsAllowed: false;
  }>;
}>;

export type CatalogProviderProfileSourceObservationUpdateCommand = Readonly<{
  section: "source-observation";
  sourceObservation: JsonObject | null;
}>;

export type CatalogProviderProfileNormalizedObservationUpdateCommand = Readonly<{
  section: "normalized-observation";
  normalizedObservationMapping?: JsonObject;
  normalizedObservationContract?: JsonObject;
}>;

export type CatalogProviderProfileExternalReferencesUpdateCommand = Readonly<{
  section: "external-references";
  externalReferenceExtractionRules?: JsonObject;
  externalReferenceContracts?: readonly JsonObject[];
}>;

export type CatalogProviderProfileSelectedOptionsUpdateCommand = Readonly<{
  section: "selected-options";
  selectedOptionMapping: JsonObject | null;
}>;

export type CatalogProviderProfileReferenceHierarchyUpdateCommand = Readonly<{
  section: "reference-hierarchy";
  referenceHierarchyMapping?: JsonObject;
  referenceHierarchyContracts?: readonly JsonObject[];
}>;

export type CatalogProviderProfileDuplicatePreventionUpdateCommand = Readonly<{
  section: "duplicate-prevention";
  duplicatePreventionMapping?: JsonObject;
  ambiguityRules?: JsonObject;
  duplicatePreventionContract?: JsonObject;
}>;

export type CatalogProviderProfilePromotionPlanUpdateCommand = Readonly<{
  section: "promotion-plan";
  promotionCommandPlan: JsonObject;
}>;

export type CatalogProviderProfileRetirementPlanUpdateCommand = Readonly<{
  section: "retirement-plan";
  retirementPlan: JsonValue;
}>;

export type CatalogProviderProfileMigrationEvidenceUpdateCommand = Readonly<{
  section: "migration-evidence";
  migrationEvidence: JsonObject | null;
}>;

export type CatalogProviderProfileSectionUpdateCommand =
  | CatalogProviderProfileBasicsUpdateCommand
  | CatalogProviderProfileProviderOptionsUpdateCommand
  | CatalogProviderProfileConnectorUpdateCommand
  | CatalogProviderProfileCatalogFieldMappingUpdateCommand
  | CatalogProviderProfileSourceContractUpdateCommand
  | CatalogProviderProfileFixturesUpdateCommand
  | CatalogProviderProfileSourceObservationUpdateCommand
  | CatalogProviderProfileNormalizedObservationUpdateCommand
  | CatalogProviderProfileExternalReferencesUpdateCommand
  | CatalogProviderProfileSelectedOptionsUpdateCommand
  | CatalogProviderProfileReferenceHierarchyUpdateCommand
  | CatalogProviderProfileDuplicatePreventionUpdateCommand
  | CatalogProviderProfilePromotionPlanUpdateCommand
  | CatalogProviderProfileRetirementPlanUpdateCommand
  | CatalogProviderProfileMigrationEvidenceUpdateCommand;

export class CatalogProviderProfileSectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogProviderProfileSectionValidationError";
  }
}

export function parseCatalogProviderProfileSectionUpdateCommand(
  value: unknown,
  sectionOverride?: string,
): CatalogProviderProfileSectionUpdateCommand {
  const command =
    sectionOverride && isJsonObject(value)
      ? {
          ...value,
          section: sectionOverride,
        }
      : value;

  assertProfileSectionCommand(command);
  return command;
}

function assertProfileSectionCommand(value: unknown): asserts value is CatalogProviderProfileSectionUpdateCommand {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("Profile section update command must be a JSON object.");
  }

  switch (value.section) {
    case "basics":
      assertOptionalString(value.displayName, "displayName");
      assertOptionalEnum(value.status, ["active", "planned"], "status");
      assertOptionalEnum(value.lifecycle, ["draft", "test"], "lifecycle");
      assertOptionalEnum(
        value.compatibilityMode,
        ["executable-mapping-contract", "transitional-static-profile"],
        "compatibilityMode",
      );
      assertOptionalStringArray(value.capabilities, "capabilities");
      assertOptionalStringArray(value.supportedScopes, "supportedScopes");
      assertOptionalStringArray(value.languageOptions, "languageOptions");
      break;
    case "provider-options":
      assertRequiredArray(value.optionQueries, "optionQueries");
      break;
    case "connector":
      assertRequiredObject(value.connector, "connector");
      assertOptionalObject(value.mappingConnector, "mappingConnector");
      break;
    case "catalog-field-mapping":
      assertRequiredObject(value.catalogFieldMapping, "catalogFieldMapping");
      break;
    case "source-contract":
      assertSourceContract(value.sourceContract);
      break;
    case "fixtures":
      assertFixtureContract(value.fixtures);
      break;
    case "source-observation":
      if (value.sourceObservation !== null) {
        assertRequiredObject(value.sourceObservation, "sourceObservation");
      }
      break;
    case "normalized-observation":
      assertAtLeastOneSectionField(value, ["normalizedObservationMapping", "normalizedObservationContract"]);
      assertOptionalObject(value.normalizedObservationMapping, "normalizedObservationMapping");
      assertOptionalObject(value.normalizedObservationContract, "normalizedObservationContract");
      break;
    case "external-references":
      assertAtLeastOneSectionField(value, ["externalReferenceExtractionRules", "externalReferenceContracts"]);
      assertOptionalObject(value.externalReferenceExtractionRules, "externalReferenceExtractionRules");
      if (value.externalReferenceContracts !== undefined) {
        assertRequiredArray(value.externalReferenceContracts, "externalReferenceContracts");
      }
      break;
    case "selected-options":
      if (value.selectedOptionMapping !== null) {
        assertRequiredObject(value.selectedOptionMapping, "selectedOptionMapping");
      }
      break;
    case "reference-hierarchy":
      assertAtLeastOneSectionField(value, ["referenceHierarchyMapping", "referenceHierarchyContracts"]);
      assertOptionalObject(value.referenceHierarchyMapping, "referenceHierarchyMapping");
      if (value.referenceHierarchyContracts !== undefined) {
        assertRequiredArray(value.referenceHierarchyContracts, "referenceHierarchyContracts");
      }
      break;
    case "duplicate-prevention":
      assertAtLeastOneSectionField(value, [
        "duplicatePreventionMapping",
        "ambiguityRules",
        "duplicatePreventionContract",
      ]);
      assertOptionalObject(value.duplicatePreventionMapping, "duplicatePreventionMapping");
      assertOptionalObject(value.ambiguityRules, "ambiguityRules");
      assertOptionalObject(value.duplicatePreventionContract, "duplicatePreventionContract");
      break;
    case "promotion-plan":
      assertRequiredObject(value.promotionCommandPlan, "promotionCommandPlan");
      break;
    case "retirement-plan":
      if (value.retirementPlan !== null) {
        assertRetirementPlan(value.retirementPlan);
      }
      break;
    case "migration-evidence":
      if (value.migrationEvidence !== null) {
        assertMigrationEvidence(value.migrationEvidence);
      }
      break;
    default:
      throw new CatalogProviderProfileSectionValidationError("Unsupported profile section update command.");
  }
}

function assertAtLeastOneSectionField(command: Record<string, unknown>, fields: readonly string[]): void {
  if (!fields.some((field) => Object.prototype.hasOwnProperty.call(command, field))) {
    throw new CatalogProviderProfileSectionValidationError(
      `Profile section '${String(command.section)}' must include at least one editable field.`,
    );
  }
}

function assertOptionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be a string when provided.`);
  }
}

function assertOptionalStringArray(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be an array of strings when provided.`);
  }
}

function assertRequiredArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be an array.`);
  }
}

function assertRequiredObject(value: unknown, path: string): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be a JSON object.`);
  }
}

function assertOptionalObject(value: unknown, path: string): void {
  if (value !== undefined && !isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be a JSON object when provided.`);
  }
}

function assertOptionalEnum(value: unknown, allowed: readonly string[], path: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    throw new CatalogProviderProfileSectionValidationError(`${path} is not a supported value.`);
  }
}

function assertRequiredString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be a non-empty string.`);
  }
}

function assertSourceContract(value: unknown): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("sourceContract must be a JSON object.");
  }
  assertRequiredString(value.owner, "sourceContract.owner");
  if (value.repository !== null && typeof value.repository !== "string") {
    throw new CatalogProviderProfileSectionValidationError("sourceContract.repository must be a string or null.");
  }
  if (value.commit !== null && typeof value.commit !== "string") {
    throw new CatalogProviderProfileSectionValidationError("sourceContract.commit must be a string or null.");
  }
  assertRequiredString(value.documentPath, "sourceContract.documentPath");
  assertRequiredString(value.fixtureSetVersion, "sourceContract.fixtureSetVersion");
}

function assertFixtureContract(value: unknown): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("fixtures must be a JSON object.");
  }
  assertRequiredString(value.fixtureRoot, "fixtures.fixtureRoot");
  assertOptionalStringArray(value.coveredFlows, "fixtures.coveredFlows");
  if (value.liveProviderCallsAllowed !== false) {
    throw new CatalogProviderProfileSectionValidationError("fixtures.liveProviderCallsAllowed must remain false.");
  }
}

function assertRetirementPlan(value: unknown): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("retirementPlan must be a JSON object or null.");
  }
  if (typeof value.trackingIssue !== "number") {
    throw new CatalogProviderProfileSectionValidationError("retirementPlan.trackingIssue must be a number.");
  }
  if (value.removeAfter !== "executable-mapping-contract-activated") {
    throw new CatalogProviderProfileSectionValidationError("retirementPlan.removeAfter is not supported.");
  }
  assertRequiredString(value.diagnosticText, "retirementPlan.diagnosticText");
}

function assertMigrationEvidence(value: unknown): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("migrationEvidence must be a JSON object or null.");
  }
  assertRequiredString(value.evidenceText, "migrationEvidence.evidenceText");
  assertRequiredString(value.recordedAt, "migrationEvidence.recordedAt");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
