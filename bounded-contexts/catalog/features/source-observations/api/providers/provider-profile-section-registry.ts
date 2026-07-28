import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderIntegrationProfile,
  CatalogProviderIntegrationProfileMigrationEvidence,
  CatalogProviderIntegrationProfileRetirementPlan,
  CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import type {
  CatalogProviderDuplicatePreventionContract,
  CatalogProviderExecutableMappingContract,
  CatalogProviderExternalReferenceContract,
  CatalogProviderMappingConnectorContract,
  CatalogProviderNormalizedObservationContract,
  CatalogProviderProfileFixtureContract,
  CatalogProviderPromotionCommandPlanContract,
  CatalogProviderReferenceHierarchyContract,
  CatalogProviderSourceObservationContract,
} from "./provider-integration-mapping-contract";

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
    liveProviderCallsAllowed: boolean;
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

export type CatalogProviderProfileVersionUpdatePatch = Readonly<{
  lifecycle?: "draft" | "test";
  profile?: CatalogProviderIntegrationProfileVersionRecord["profile"];
  sourceContract?: CatalogProviderIntegrationProfileVersionRecord["sourceContract"];
  fixtures?: CatalogProviderIntegrationProfileVersionRecord["fixtures"];
  retirementPlan?: CatalogProviderIntegrationProfileVersionRecord["retirementPlan"];
  executableMappingContract?: CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"] | null;
  migrationEvidence?: CatalogProviderIntegrationProfileMigrationEvidence | null;
}>;

export type CatalogProviderProfileEditableSectionMetadata = Readonly<{
  section: CatalogProviderProfileEditableSectionKey;
  displayName: string;
  requiredPermission: "catalog.manage";
  rawJsonBacked: false;
}>;

export type CatalogProviderProfileSectionDefinition = Readonly<{
  section: CatalogProviderProfileEditableSectionKey;
  displayName: string;
  validateCommand: (command: JsonObject) => void;
  composePatch: (
    existing: CatalogProviderIntegrationProfileVersionRecord,
    command: CatalogProviderProfileSectionUpdateCommand,
  ) => CatalogProviderProfileVersionUpdatePatch;
}>;

export class CatalogProviderProfileSectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogProviderProfileSectionValidationError";
  }
}

export const catalogProviderProfileSectionRegistry = [
  defineSection<CatalogProviderProfileBasicsUpdateCommand>({
    section: "basics",
    displayName: "Basics",
    validateCommand: (command) => {
      assertOptionalString(command.displayName, "displayName");
      assertOptionalEnum(command.status, ["active", "planned"], "status");
      assertOptionalEnum(command.lifecycle, ["draft", "test"], "lifecycle");
      assertOptionalStringArray(command.capabilities, "capabilities");
      assertOptionalStringArray(command.supportedScopes, "supportedScopes");
      assertOptionalStringArray(command.languageOptions, "languageOptions");
    },
    composePatch: (existing, command) => ({
      lifecycle: command.lifecycle,
      profile: {
        ...existing.profile,
        displayName: command.displayName ?? existing.profile.displayName,
        status: command.status ?? existing.profile.status,
        capabilities:
          (command.capabilities as CatalogProviderIntegrationProfile["capabilities"] | undefined) ??
          existing.profile.capabilities,
        supportedScopes:
          (command.supportedScopes as CatalogProviderIntegrationProfile["supportedScopes"] | undefined) ??
          existing.profile.supportedScopes,
        languageOptions: command.languageOptions ?? existing.profile.languageOptions,
      },
      executableMappingContract: existing.executableMappingContract
        ? {
            ...existing.executableMappingContract,
            displayName: command.displayName ?? existing.executableMappingContract.displayName,
            lifecycle: command.lifecycle ?? existing.lifecycle,
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileProviderOptionsUpdateCommand>({
    section: "provider-options",
    displayName: "Provider Options",
    validateCommand: (command) => assertRequiredArray(command.optionQueries, "optionQueries"),
    composePatch: (existing, command) => ({
      profile: {
        ...existing.profile,
        optionQueries: command.optionQueries as CatalogProviderIntegrationProfile["optionQueries"],
      },
    }),
  }),
  defineSection<CatalogProviderProfileConnectorUpdateCommand>({
    section: "connector",
    displayName: "Connector",
    validateCommand: (command) => {
      assertRequiredObject(command.connector, "connector");
      assertOptionalObject(command.mappingConnector, "mappingConnector");
    },
    composePatch: (existing, command) => ({
      profile: {
        ...existing.profile,
        connector: command.connector as CatalogProviderIntegrationProfile["connector"],
      },
      executableMappingContract: existing.executableMappingContract
        ? {
            ...existing.executableMappingContract,
            ...(command.mappingConnector
              ? { connector: command.mappingConnector as CatalogProviderMappingConnectorContract }
              : {}),
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileCatalogFieldMappingUpdateCommand>({
    section: "catalog-field-mapping",
    displayName: "Catalog Field Mapping",
    validateCommand: (command) => assertRequiredObject(command.catalogFieldMapping, "catalogFieldMapping"),
    composePatch: (existing, command) => ({
      profile: {
        ...existing.profile,
        catalogFieldMapping: command.catalogFieldMapping as CatalogProviderIntegrationProfile["catalogFieldMapping"],
      },
    }),
  }),
  defineSection<CatalogProviderProfileSourceContractUpdateCommand>({
    section: "source-contract",
    displayName: "Source Contract",
    validateCommand: (command) => assertSourceContract(command.sourceContract),
    composePatch: (existing, command) => ({
      sourceContract: command.sourceContract,
      executableMappingContract: existing.executableMappingContract
        ? {
            ...existing.executableMappingContract,
            sourceContract: command.sourceContract,
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileFixturesUpdateCommand>({
    section: "fixtures",
    displayName: "Fixtures",
    validateCommand: (command) => assertFixtureContract(command.fixtures),
    composePatch: (existing, command) => ({
      fixtures: command.fixtures as CatalogProviderProfileFixtureContract,
      executableMappingContract: existing.executableMappingContract
        ? {
            ...existing.executableMappingContract,
            fixtures: command.fixtures as CatalogProviderProfileFixtureContract,
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileSourceObservationUpdateCommand>({
    section: "source-observation",
    displayName: "Source Observation",
    validateCommand: (command) => {
      if (command.sourceObservation !== null) {
        assertRequiredObject(command.sourceObservation, "sourceObservation");
      }
    },
    composePatch: (existing, command) => {
      const executableMappingContract = requireExecutableMappingContractForSection(existing, command.section);
      return {
        executableMappingContract: {
          ...executableMappingContract,
          sourceObservation:
            (command.sourceObservation as CatalogProviderSourceObservationContract | null) ?? undefined,
        },
      };
    },
  }),
  defineSection<CatalogProviderProfileNormalizedObservationUpdateCommand>({
    section: "normalized-observation",
    displayName: "Normalized Observation",
    validateCommand: (command) => {
      assertAtLeastOneSectionField(command, ["normalizedObservationMapping", "normalizedObservationContract"]);
      assertOptionalObject(command.normalizedObservationMapping, "normalizedObservationMapping");
      assertOptionalObject(command.normalizedObservationContract, "normalizedObservationContract");
    },
    composePatch: (existing, command) => ({
      profile: command.normalizedObservationMapping
        ? {
            ...existing.profile,
            normalizedObservationMapping:
              command.normalizedObservationMapping as CatalogProviderIntegrationProfile["normalizedObservationMapping"],
          }
        : undefined,
      executableMappingContract: command.normalizedObservationContract
        ? {
            ...requireExecutableMappingContractForSection(existing, command.section),
            normalizedObservation:
              command.normalizedObservationContract as CatalogProviderNormalizedObservationContract,
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileExternalReferencesUpdateCommand>({
    section: "external-references",
    displayName: "External References",
    validateCommand: (command) => {
      assertAtLeastOneSectionField(command, ["externalReferenceExtractionRules", "externalReferenceContracts"]);
      assertOptionalObject(command.externalReferenceExtractionRules, "externalReferenceExtractionRules");
      if (command.externalReferenceContracts !== undefined) {
        assertRequiredArray(command.externalReferenceContracts, "externalReferenceContracts");
      }
    },
    composePatch: (existing, command) => ({
      profile: command.externalReferenceExtractionRules
        ? {
            ...existing.profile,
            externalReferenceExtractionRules:
              command.externalReferenceExtractionRules as CatalogProviderIntegrationProfile["externalReferenceExtractionRules"],
          }
        : undefined,
      executableMappingContract: command.externalReferenceContracts
        ? {
            ...requireExecutableMappingContractForSection(existing, command.section),
            externalReferences:
              command.externalReferenceContracts as readonly CatalogProviderExternalReferenceContract[],
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileSelectedOptionsUpdateCommand>({
    section: "selected-options",
    displayName: "Selected Options",
    validateCommand: (command) => {
      if (command.selectedOptionMapping !== null) {
        assertRequiredObject(command.selectedOptionMapping, "selectedOptionMapping");
      }
    },
    composePatch: (existing, command) => ({
      profile: {
        ...existing.profile,
        ...(command.selectedOptionMapping
          ? {
              selectedOptionMapping:
                command.selectedOptionMapping as CatalogProviderIntegrationProfile["selectedOptionMapping"],
            }
          : { selectedOptionMapping: undefined }),
      },
    }),
  }),
  defineSection<CatalogProviderProfileReferenceHierarchyUpdateCommand>({
    section: "reference-hierarchy",
    displayName: "Reference Hierarchy",
    validateCommand: (command) => {
      assertAtLeastOneSectionField(command, ["referenceHierarchyMapping", "referenceHierarchyContracts"]);
      assertOptionalObject(command.referenceHierarchyMapping, "referenceHierarchyMapping");
      if (command.referenceHierarchyContracts !== undefined) {
        assertRequiredArray(command.referenceHierarchyContracts, "referenceHierarchyContracts");
      }
    },
    composePatch: (existing, command) => ({
      profile: command.referenceHierarchyMapping
        ? {
            ...existing.profile,
            referenceHierarchyMapping:
              command.referenceHierarchyMapping as CatalogProviderIntegrationProfile["referenceHierarchyMapping"],
          }
        : undefined,
      executableMappingContract: command.referenceHierarchyContracts
        ? {
            ...requireExecutableMappingContractForSection(existing, command.section),
            referenceHierarchy:
              command.referenceHierarchyContracts as readonly CatalogProviderReferenceHierarchyContract[],
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfileDuplicatePreventionUpdateCommand>({
    section: "duplicate-prevention",
    displayName: "Duplicate Prevention",
    validateCommand: (command) => {
      assertAtLeastOneSectionField(command, [
        "duplicatePreventionMapping",
        "ambiguityRules",
        "duplicatePreventionContract",
      ]);
      assertOptionalObject(command.duplicatePreventionMapping, "duplicatePreventionMapping");
      assertOptionalObject(command.ambiguityRules, "ambiguityRules");
      assertOptionalObject(command.duplicatePreventionContract, "duplicatePreventionContract");
    },
    composePatch: (existing, command) => ({
      profile:
        command.duplicatePreventionMapping || command.ambiguityRules
          ? {
              ...existing.profile,
              duplicatePreventionMapping:
                (command.duplicatePreventionMapping as
                  | CatalogProviderIntegrationProfile["duplicatePreventionMapping"]
                  | undefined) ?? existing.profile.duplicatePreventionMapping,
              ambiguityRules:
                (command.ambiguityRules as CatalogProviderIntegrationProfile["ambiguityRules"] | undefined) ??
                existing.profile.ambiguityRules,
            }
          : undefined,
      executableMappingContract: command.duplicatePreventionContract
        ? {
            ...requireExecutableMappingContractForSection(existing, command.section),
            duplicatePrevention: command.duplicatePreventionContract as CatalogProviderDuplicatePreventionContract,
          }
        : undefined,
    }),
  }),
  defineSection<CatalogProviderProfilePromotionPlanUpdateCommand>({
    section: "promotion-plan",
    displayName: "Promotion Plan",
    validateCommand: (command) => assertRequiredObject(command.promotionCommandPlan, "promotionCommandPlan"),
    composePatch: (existing, command) => ({
      executableMappingContract: {
        ...requireExecutableMappingContractForSection(existing, command.section),
        promotionCommandPlan: command.promotionCommandPlan as CatalogProviderPromotionCommandPlanContract,
      },
    }),
  }),
  defineSection<CatalogProviderProfileRetirementPlanUpdateCommand>({
    section: "retirement-plan",
    displayName: "Retirement Plan",
    validateCommand: (command) => {
      if (command.retirementPlan !== null) {
        assertRetirementPlan(command.retirementPlan);
      }
    },
    composePatch: (_existing, command) => ({
      retirementPlan: command.retirementPlan as CatalogProviderIntegrationProfileRetirementPlan | null,
    }),
  }),
  defineSection<CatalogProviderProfileMigrationEvidenceUpdateCommand>({
    section: "migration-evidence",
    displayName: "Migration Evidence",
    validateCommand: (command) => {
      if (command.migrationEvidence !== null) {
        assertMigrationEvidence(command.migrationEvidence);
      }
    },
    composePatch: (_existing, command) => ({
      migrationEvidence: command.migrationEvidence as CatalogProviderIntegrationProfileMigrationEvidence | null,
    }),
  }),
] satisfies readonly CatalogProviderProfileSectionDefinition[];

export const catalogProviderProfileEditableSectionDefinitions =
  catalogProviderProfileSectionRegistry satisfies readonly CatalogProviderProfileSectionDefinition[];

export function catalogProviderProfileEditableSectionMetadata(): readonly CatalogProviderProfileEditableSectionMetadata[] {
  return catalogProviderProfileSectionRegistry.map((definition) => ({
    section: definition.section,
    displayName: definition.displayName,
    requiredPermission: "catalog.manage",
    rawJsonBacked: false,
  }));
}

export function getCatalogProviderProfileSectionDefinition(
  section: string,
): CatalogProviderProfileSectionDefinition | null {
  return catalogProviderProfileSectionRegistry.find((definition) => definition.section === section) ?? null;
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

  if (!isJsonObject(command)) {
    throw new CatalogProviderProfileSectionValidationError("Profile section update command must be a JSON object.");
  }

  const definition = getCatalogProviderProfileSectionDefinition(String(command.section));
  if (!definition) {
    throw new CatalogProviderProfileSectionValidationError("Unsupported profile section update command.");
  }

  definition.validateCommand(command);
  return command as CatalogProviderProfileSectionUpdateCommand;
}

export function toCatalogProviderProfileSectionPatch(
  existing: CatalogProviderIntegrationProfileVersionRecord,
  command: CatalogProviderProfileSectionUpdateCommand,
): CatalogProviderProfileVersionUpdatePatch {
  const parsed = parseCatalogProviderProfileSectionUpdateCommand(command);
  const definition = getCatalogProviderProfileSectionDefinition(parsed.section);
  if (!definition) {
    throw new CatalogProviderProfileSectionValidationError("Unsupported profile section update command.");
  }

  return definition.composePatch(existing, parsed);
}

function defineSection<TCommand extends CatalogProviderProfileSectionUpdateCommand>(input: {
  section: TCommand["section"];
  displayName: string;
  validateCommand: (command: JsonObject) => void;
  composePatch: (
    existing: CatalogProviderIntegrationProfileVersionRecord,
    command: TCommand,
  ) => CatalogProviderProfileVersionUpdatePatch;
}): CatalogProviderProfileSectionDefinition {
  return {
    section: input.section,
    displayName: input.displayName,
    validateCommand: input.validateCommand,
    composePatch: (existing, command) => input.composePatch(existing, command as TCommand),
  };
}

function requireExecutableMappingContractForSection(
  version: CatalogProviderIntegrationProfileVersionRecord,
  section: CatalogProviderProfileEditableSectionKey,
): CatalogProviderExecutableMappingContract {
  if (!version.executableMappingContract) {
    throw new CatalogProviderProfileSectionValidationError(
      `Profile section '${section}' requires an executable mapping contract.`,
    );
  }

  return version.executableMappingContract;
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
