import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import { parseCatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  CatalogProviderIntegrationProfileMigrationEvidence,
  CatalogProviderIntegrationProfileVersionDiagnostic,
  CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  validateCatalogProviderIntegrationProfileVersion,
} from "../provider-integration-profiles";
import type {
  CatalogProviderIngestionPurpose,
  CatalogProviderIngestionUnitIdentityContract,
  CatalogProviderIngestionUnitProductDomain,
  CatalogProviderIngestionUnitProductForm,
  CatalogProviderProfileFixtureFlow,
  CatalogProviderProfileLifecycle,
} from "./provider-integration-mapping-contract";
import {
  catalogProviderRequiredFixtureFlows,
  defineCatalogProviderIngestionUnitIdentityContract,
} from "./provider-integration-mapping-contract";

export type CatalogProviderIngestionUnitProfileIdentity = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  productDomain: CatalogProviderIngestionUnitProductDomain;
  productForm: CatalogProviderIngestionUnitProductForm;
  ingestionPurpose: CatalogProviderIngestionPurpose;
  displayName: string;
}>;

export type CatalogProviderProfileSectionKey =
  | "ingestion-unit-identity"
  | "profile-identity"
  | "profile-lifecycle"
  | "source-contract"
  | "fixture-contract"
  | "provider-options"
  | "connector-binding"
  | "normalized-observation"
  | "condition-certification-mapping"
  | "external-references"
  | "selected-options"
  | "reference-hierarchy"
  | "duplicate-prevention"
  | "promotion-plan"
  | "migration-evidence"
  | "retirement-plan";

export type CatalogProviderProfileSectionDiagnostic = Readonly<{
  code: string;
  path: string;
  diagnosticText: string;
  severity: "error" | "warning";
}>;

export type CatalogProviderProfileSectionValidation = Readonly<{
  status: "valid" | "invalid";
  diagnostics: readonly CatalogProviderProfileSectionDiagnostic[];
}>;

export type CatalogProviderProfileSectionBase<TKey extends CatalogProviderProfileSectionKey> = Readonly<{
  sectionKey: TKey;
  ingestionUnitKey: CatalogIntegrationUnitKey;
  editable: boolean;
  validation: CatalogProviderProfileSectionValidation;
}>;

export type CatalogProviderIngestionUnitIdentitySection = CatalogProviderProfileSectionBase<"ingestion-unit-identity"> &
  Readonly<{
    value: CatalogProviderIngestionUnitProfileIdentity;
  }>;

export type CatalogProviderProfileIdentitySection = CatalogProviderProfileSectionBase<"profile-identity"> &
  Readonly<{
    value: Readonly<{
      providerKey: string;
      profileKey: string;
      profileVersion: string;
      displayName: string;
      status: CatalogProviderIntegrationProfileVersionRecord["profile"]["status"];
      capabilities: CatalogProviderIntegrationProfileVersionRecord["profile"]["capabilities"];
      supportedScopes: CatalogProviderIntegrationProfileVersionRecord["profile"]["supportedScopes"];
      languageOptions: readonly string[];
    }>;
  }>;

export type CatalogProviderProfileLifecycleSection = CatalogProviderProfileSectionBase<"profile-lifecycle"> &
  Readonly<{
    value: Readonly<{
      lifecycle: CatalogProviderProfileLifecycle;
      active: boolean;
      canEdit: boolean;
    }>;
  }>;

export type CatalogProviderProfileSourceContractSection = CatalogProviderProfileSectionBase<"source-contract"> &
  Readonly<{ value: CatalogProviderIntegrationProfileVersionRecord["sourceContract"] }>;

export type CatalogProviderProfileFixtureContractSection = CatalogProviderProfileSectionBase<"fixture-contract"> &
  Readonly<{ value: CatalogProviderIntegrationProfileVersionRecord["fixtures"] }>;

export type CatalogProviderProfileProviderOptionsSection = CatalogProviderProfileSectionBase<"provider-options"> &
  Readonly<{
    value: Readonly<{
      optionQueries: CatalogProviderIntegrationProfileVersionRecord["profile"]["optionQueries"];
      languageOptions: readonly string[];
      supportedScopes: CatalogProviderIntegrationProfileVersionRecord["profile"]["supportedScopes"];
    }>;
  }>;

export type CatalogProviderProfileConnectorBindingSection = CatalogProviderProfileSectionBase<"connector-binding"> &
  Readonly<{
    value: Readonly<{
      profileConnectorKind: string;
      mappingConnectorKind: string | null;
      transportBoundary: "adapter-owned";
      transportOwns: readonly string[];
      mappingOwns: readonly string[];
    }>;
  }>;

export type CatalogProviderProfileNormalizedObservationSection =
  CatalogProviderProfileSectionBase<"normalized-observation"> &
    Readonly<{
      value: Readonly<{
        profileMapping: CatalogProviderIntegrationProfileVersionRecord["profile"]["normalizedObservationMapping"];
        executableContract:
          | NonNullable<
              CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"]
            >["normalizedObservation"]
          | null;
        catalogFieldMapping: CatalogProviderIntegrationProfileVersionRecord["profile"]["catalogFieldMapping"];
      }>;
    }>;

export type CatalogProviderProfileConditionCertificationMappingSection =
  CatalogProviderProfileSectionBase<"condition-certification-mapping"> &
    Readonly<{
      value: Readonly<{
        rawAndGradedMode: "condition-certification-within-single-card" | "not-declared";
        forbiddenUnitProductForms: readonly ["raw-card", "graded-card"];
        selectedOptionDimensions: readonly string[];
        productReferenceRequiredSourceKeys: readonly string[];
      }>;
    }>;

export type CatalogProviderProfileExternalReferencesSection = CatalogProviderProfileSectionBase<"external-references"> &
  Readonly<{
    value: Readonly<{
      profileRules: CatalogProviderIntegrationProfileVersionRecord["profile"]["externalReferenceExtractionRules"];
      executableContracts:
        | NonNullable<CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"]>["externalReferences"]
        | null;
    }>;
  }>;

export type CatalogProviderProfileSelectedOptionsSection = CatalogProviderProfileSectionBase<"selected-options"> &
  Readonly<{ value: CatalogProviderIntegrationProfileVersionRecord["profile"]["selectedOptionMapping"] | null }>;

export type CatalogProviderProfileReferenceHierarchySection = CatalogProviderProfileSectionBase<"reference-hierarchy"> &
  Readonly<{
    value: Readonly<{
      profileMapping: CatalogProviderIntegrationProfileVersionRecord["profile"]["referenceHierarchyMapping"];
      executableContracts:
        | NonNullable<CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"]>["referenceHierarchy"]
        | null;
    }>;
  }>;

export type CatalogProviderProfileDuplicatePreventionSection =
  CatalogProviderProfileSectionBase<"duplicate-prevention"> &
    Readonly<{
      value: Readonly<{
        profileMapping: CatalogProviderIntegrationProfileVersionRecord["profile"]["duplicatePreventionMapping"];
        ambiguityRules: CatalogProviderIntegrationProfileVersionRecord["profile"]["ambiguityRules"];
        executableContract:
          | NonNullable<
              CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"]
            >["duplicatePrevention"]
          | null;
      }>;
    }>;

export type CatalogProviderProfilePromotionPlanSection = CatalogProviderProfileSectionBase<"promotion-plan"> &
  Readonly<{
    value:
      | NonNullable<CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"]>["promotionCommandPlan"]
      | null;
  }>;

export type CatalogProviderProfileMigrationEvidenceSection = CatalogProviderProfileSectionBase<"migration-evidence"> &
  Readonly<{ value: CatalogProviderIntegrationProfileMigrationEvidence | null }>;

export type CatalogProviderProfileRetirementPlanSection = CatalogProviderProfileSectionBase<"retirement-plan"> &
  Readonly<{ value: CatalogProviderIntegrationProfileVersionRecord["retirementPlan"] }>;

export type CatalogProviderIngestionUnitProfileSections = Readonly<{
  ingestionUnitIdentity: CatalogProviderIngestionUnitIdentitySection;
  profileIdentity: CatalogProviderProfileIdentitySection;
  profileLifecycle: CatalogProviderProfileLifecycleSection;
  sourceContract: CatalogProviderProfileSourceContractSection;
  fixtureContract: CatalogProviderProfileFixtureContractSection;
  providerOptions: CatalogProviderProfileProviderOptionsSection;
  connectorBinding: CatalogProviderProfileConnectorBindingSection;
  normalizedObservation: CatalogProviderProfileNormalizedObservationSection;
  conditionCertificationMapping: CatalogProviderProfileConditionCertificationMappingSection;
  externalReferences: CatalogProviderProfileExternalReferencesSection;
  selectedOptions: CatalogProviderProfileSelectedOptionsSection;
  referenceHierarchy: CatalogProviderProfileReferenceHierarchySection;
  duplicatePrevention: CatalogProviderProfileDuplicatePreventionSection;
  promotionPlan: CatalogProviderProfilePromotionPlanSection;
  migrationEvidence: CatalogProviderProfileMigrationEvidenceSection;
  retirementPlan: CatalogProviderProfileRetirementPlanSection;
}>;

export type CatalogProviderProfileActivationReadinessInput = Readonly<{
  lifecycle: CatalogProviderProfileLifecycle;
  hasSourceObservationImportCapability: boolean;
  hasExecutableMappingContract: boolean;
  fixtureContract: CatalogProviderIntegrationProfileVersionRecord["fixtures"];
  requiredFixtureFlows: readonly CatalogProviderProfileFixtureFlow[];
  validationDiagnostics: readonly CatalogProviderIntegrationProfileVersionDiagnostic[];
  migrationEvidenceRequired: boolean;
  migrationEvidenceRecorded: boolean;
}>;

export type CatalogProviderProfileLifecyclePolicy = Readonly<{
  canEdit: boolean;
  activation: CatalogProviderLifecycleOperationPolicy;
  deprecation: CatalogProviderLifecycleOperationPolicy;
  retirement: CatalogProviderLifecycleOperationPolicy;
}>;

export type CatalogProviderLifecycleOperationPolicy = Readonly<{
  allowed: boolean;
  blockers: readonly CatalogProviderProfileSectionDiagnostic[];
}>;

export type CatalogProviderProfileActivationReadiness = Readonly<{
  status: "ready" | "blocked";
  checks: readonly CatalogProviderProfileActivationReadinessCheck[];
}>;

export type CatalogProviderProfileActivationReadinessCheck = CatalogProviderProfileSectionDiagnostic &
  Readonly<{
    status: "passed" | "blocked";
  }>;

export function defineCatalogProviderIngestionUnitProfileIdentity(
  input: Readonly<{
    providerKey: string;
    productDomain: CatalogProviderIngestionUnitProductDomain;
    productForm: CatalogProviderIngestionUnitProductForm | "raw-card" | "graded-card";
    ingestionPurpose?: CatalogProviderIngestionPurpose;
    displayName: string;
  }>,
): CatalogProviderIngestionUnitProfileIdentity {
  if (input.productForm === "raw-card" || input.productForm === "graded-card") {
    throw new Error(
      "Raw and graded cards must be modeled as condition/certification semantics inside a single-card ingestion unit.",
    );
  }

  const identity = defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: input.providerKey,
    productDomain: input.productDomain,
    productForm: input.productForm,
    ingestionPurpose: input.ingestionPurpose ?? "source-observation-import",
  });

  return {
    ...identity,
    displayName: input.displayName,
  };
}

export function assembleCatalogProviderIngestionUnitProfileSections(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIngestionUnitProfileSections {
  const identity = inferCatalogProviderIngestionUnitProfileIdentity(version);
  const editable = canEditCatalogProviderIngestionUnitProfile(version.lifecycle);
  const executableMappingContract = version.executableMappingContract ?? null;
  const validationDiagnostics = validateCatalogProviderIntegrationProfileVersion(version).map((entry) =>
    toSectionDiagnostic(entry),
  );
  const baseInput = { ingestionUnitKey: identity.unitKey, editable };

  return {
    ingestionUnitIdentity: section("ingestion-unit-identity", baseInput, identity, [
      ...validateIngestionUnitIdentity(identity, version),
    ]),
    profileIdentity: section("profile-identity", baseInput, {
      providerKey: version.providerKey,
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      displayName: version.profile.displayName,
      status: version.profile.status,
      capabilities: version.profile.capabilities,
      supportedScopes: version.profile.supportedScopes,
      languageOptions: version.profile.languageOptions,
    }),
    profileLifecycle: section("profile-lifecycle", baseInput, {
      lifecycle: version.lifecycle,
      active: version.active,
      canEdit: editable,
    }),
    sourceContract: section("source-contract", baseInput, version.sourceContract),
    fixtureContract: section(
      "fixture-contract",
      baseInput,
      version.fixtures,
      validateFixtureContract(version.fixtures),
    ),
    providerOptions: section("provider-options", baseInput, {
      optionQueries: version.profile.optionQueries,
      languageOptions: version.profile.languageOptions,
      supportedScopes: version.profile.supportedScopes,
    }),
    connectorBinding: section("connector-binding", baseInput, {
      profileConnectorKind: version.profile.connector.kind,
      mappingConnectorKind: executableMappingContract?.connector.kind ?? null,
      transportBoundary: "adapter-owned",
      transportOwns: executableMappingContract?.connector.transportOwns ?? [],
      mappingOwns: executableMappingContract?.connector.mappingOwns ?? [],
    }),
    normalizedObservation: section("normalized-observation", baseInput, {
      profileMapping: version.profile.normalizedObservationMapping,
      executableContract: executableMappingContract?.normalizedObservation ?? null,
      catalogFieldMapping: version.profile.catalogFieldMapping,
    }),
    conditionCertificationMapping: section(
      "condition-certification-mapping",
      baseInput,
      conditionCertificationMappingValue(identity, version),
      validateRawAndGradedUnitSemantics(identity),
    ),
    externalReferences: section("external-references", baseInput, {
      profileRules: version.profile.externalReferenceExtractionRules,
      executableContracts: executableMappingContract?.externalReferences ?? null,
    }),
    selectedOptions: section("selected-options", baseInput, version.profile.selectedOptionMapping ?? null),
    referenceHierarchy: section("reference-hierarchy", baseInput, {
      profileMapping: version.profile.referenceHierarchyMapping,
      executableContracts: executableMappingContract?.referenceHierarchy ?? null,
    }),
    duplicatePrevention: section("duplicate-prevention", baseInput, {
      profileMapping: version.profile.duplicatePreventionMapping,
      ambiguityRules: version.profile.ambiguityRules,
      executableContract: executableMappingContract?.duplicatePrevention ?? null,
    }),
    promotionPlan: section("promotion-plan", baseInput, executableMappingContract?.promotionCommandPlan ?? null),
    migrationEvidence: section("migration-evidence", baseInput, version.migrationEvidence ?? null),
    retirementPlan: section(
      "retirement-plan",
      baseInput,
      version.retirementPlan,
      validationDiagnostics.filter((diagnostic) => diagnostic.path === "retirementPlan"),
    ),
  };
}

export function canEditCatalogProviderIngestionUnitProfile(lifecycle: CatalogProviderProfileLifecycle): boolean {
  return lifecycle === "draft" || lifecycle === "test";
}

export function catalogProviderProfileActivationReadinessInput(
  version: CatalogProviderIntegrationProfileVersionRecord,
  input: Readonly<{
    activeVersion?: CatalogProviderIntegrationProfileVersionRecord | null;
    migrationEvidenceRequired?: boolean;
  }> = {},
): CatalogProviderProfileActivationReadinessInput {
  return {
    lifecycle: version.lifecycle,
    hasSourceObservationImportCapability: version.profile.capabilities.includes("source-observation-import"),
    hasExecutableMappingContract: Boolean(version.executableMappingContract),
    fixtureContract: version.fixtures,
    requiredFixtureFlows: catalogProviderRequiredFixtureFlows,
    validationDiagnostics: validateCatalogProviderIntegrationProfileVersion(version),
    migrationEvidenceRequired: input.migrationEvidenceRequired ?? false,
    migrationEvidenceRecorded: hasMigrationEvidence(version),
  };
}

export function evaluateCatalogProviderProfileActivationReadiness(
  input: CatalogProviderProfileActivationReadinessInput,
): CatalogProviderProfileActivationReadiness {
  const checks: CatalogProviderProfileActivationReadinessCheck[] = [];
  const add = (
    passed: boolean,
    code: string,
    path: string,
    diagnosticText: string,
    severity: CatalogProviderProfileSectionDiagnostic["severity"] = "error",
  ) => {
    checks.push({
      code,
      status: passed ? "passed" : "blocked",
      path,
      diagnosticText,
      severity: passed ? "warning" : severity,
    });
  };

  add(
    canEditCatalogProviderIngestionUnitProfile(input.lifecycle),
    "activation-mutable-lifecycle",
    "lifecycle",
    canEditCatalogProviderIngestionUnitProfile(input.lifecycle)
      ? "Profile version is in an activation-ready lifecycle."
      : `Only draft or test profiles can be activated; '${input.lifecycle}' is immutable.`,
  );
  add(
    input.hasExecutableMappingContract,
    "activation-executable-mapping-contract",
    "executableMappingContract",
    input.hasExecutableMappingContract
      ? "Executable mapping contract is present."
      : "Activation requires an executable mapping contract.",
  );
  add(
    input.hasSourceObservationImportCapability,
    "activation-import-eligibility",
    "profile.capabilities",
    input.hasSourceObservationImportCapability
      ? "Profile is eligible for new Source Observation imports."
      : "Activation requires the source-observation-import capability.",
  );
  add(
    !input.fixtureContract.liveProviderCallsAllowed,
    "activation-fixture-live-calls",
    "fixtures.liveProviderCallsAllowed",
    input.fixtureContract.liveProviderCallsAllowed
      ? "Fixture validation must not require live provider calls."
      : "Fixture validation is isolated from live provider calls.",
  );

  for (const flow of input.requiredFixtureFlows) {
    add(
      input.fixtureContract.coveredFlows.includes(flow),
      "activation-fixture-covered-flow",
      `fixtures.coveredFlows.${flow}`,
      input.fixtureContract.coveredFlows.includes(flow)
        ? `Profile fixture contract covers ${flow}.`
        : `Profile fixture contract must cover ${flow}.`,
    );
  }

  for (const diagnostic of input.validationDiagnostics) {
    checks.push({
      ...toSectionDiagnostic(diagnostic, "activation-profile-validation"),
      status: "blocked",
    });
  }

  add(
    !input.migrationEvidenceRequired || input.migrationEvidenceRecorded,
    "activation-migration-evidence",
    input.migrationEvidenceRequired ? "migrationEvidence.evidenceText" : "migrationEvidence",
    input.migrationEvidenceRequired
      ? input.migrationEvidenceRecorded
        ? "Migration evidence is recorded for the fingerprint change."
        : "Source Observation mapping fingerprint changes require explicit migration evidence before activation."
      : "No migration evidence is required for this activation.",
  );

  return {
    status: blockedActivationChecks(input).length > 0 ? "blocked" : "ready",
    checks,
  };
}

export function evaluateCatalogProviderProfileLifecyclePolicy(
  input: Readonly<{
    lifecycle: CatalogProviderProfileLifecycle;
    active: boolean;
    referenceCount: number;
    activationReadiness: CatalogProviderProfileActivationReadiness;
  }>,
): CatalogProviderProfileLifecyclePolicy {
  const activationBlockers =
    input.activationReadiness.status === "ready"
      ? []
      : input.activationReadiness.checks.filter(isBlockedActivationCheck);
  const deprecationBlockers =
    input.lifecycle === "active"
      ? []
      : [diagnostic("deprecation-lifecycle", "lifecycle", "Only active profile versions can be deprecated.")];
  const retirementBlockers: CatalogProviderProfileSectionDiagnostic[] = [];

  if (input.active) {
    retirementBlockers.push(
      diagnostic(
        "retirement-active-profile",
        "active",
        "Active profile versions must be deactivated before retirement.",
      ),
    );
  }
  if (input.referenceCount > 0) {
    retirementBlockers.push(
      diagnostic(
        "retirement-source-observation-references",
        "referenceCount",
        `Profile version is referenced by ${input.referenceCount} Source Observations and cannot be retired.`,
      ),
    );
  }
  if (input.lifecycle === "retired") {
    retirementBlockers.push(diagnostic("retirement-lifecycle", "lifecycle", "Profile version is already retired."));
  }

  return {
    canEdit: canEditCatalogProviderIngestionUnitProfile(input.lifecycle),
    activation: {
      allowed: activationBlockers.length === 0,
      blockers: activationBlockers,
    },
    deprecation: {
      allowed: deprecationBlockers.length === 0,
      blockers: deprecationBlockers,
    },
    retirement: {
      allowed: retirementBlockers.length === 0,
      blockers: retirementBlockers,
    },
  };
}

export function catalogProviderProfileModelsRawGradedAsConditionSemantics(
  sections: CatalogProviderIngestionUnitProfileSections,
): boolean {
  return (
    sections.ingestionUnitIdentity.value.productForm === "single-card" &&
    sections.conditionCertificationMapping.value.rawAndGradedMode === "condition-certification-within-single-card"
  );
}

function inferCatalogProviderIngestionUnitProfileIdentity(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIngestionUnitProfileIdentity {
  if (version.ingestionUnitIdentity) {
    return toProfileIdentity(version.ingestionUnitIdentity, version.profile.displayName);
  }
  if (version.executableMappingContract?.ingestionUnitIdentity) {
    return toProfileIdentity(version.executableMappingContract.ingestionUnitIdentity, version.profile.displayName);
  }

  const parsed = parseCatalogIntegrationUnitKey(catalogProviderProfileVersionIngestionUnitKey(version));
  return {
    unitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    providerKey: parsed.providerKey,
    productDomain: parsed.productDomain as CatalogProviderIngestionUnitProductDomain,
    productForm: parsed.productForm as CatalogProviderIngestionUnitProductForm,
    ingestionPurpose: (parsed.ingestionPurpose ?? "source-observation-import") as CatalogProviderIngestionPurpose,
    displayName: `${version.profile.displayName} ${parsed.productDomain} ${parsed.productForm}`,
  };
}

function toProfileIdentity(
  identity: CatalogProviderIngestionUnitIdentityContract,
  displayName: string,
): CatalogProviderIngestionUnitProfileIdentity {
  return {
    ...identity,
    displayName,
  };
}

function section<TKey extends CatalogProviderProfileSectionKey, TValue>(
  sectionKey: TKey,
  base: Readonly<{ ingestionUnitKey: CatalogIntegrationUnitKey; editable: boolean }>,
  value: TValue,
  diagnostics: readonly CatalogProviderProfileSectionDiagnostic[] = [],
): CatalogProviderProfileSectionBase<TKey> & Readonly<{ value: TValue }> {
  return {
    sectionKey,
    ingestionUnitKey: base.ingestionUnitKey,
    editable: base.editable,
    value,
    validation: {
      status: diagnostics.some((entry) => entry.severity === "error") ? "invalid" : "valid",
      diagnostics,
    },
  };
}

function conditionCertificationMappingValue(
  identity: CatalogProviderIngestionUnitProfileIdentity,
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderProfileConditionCertificationMappingSection["value"] {
  const dimensions = version.profile.selectedOptionMapping?.dimensions.map((dimension) => dimension.dimensionKey) ?? [];
  const productReferenceRequiredSourceKeys =
    version.profile.selectedOptionMapping?.productReferenceRule.requiredSourceKeys ?? [];
  const hasConditionCertificationDimension =
    dimensions.includes("condition") || dimensions.includes("product-form") || dimensions.includes("grading-company");

  return {
    rawAndGradedMode:
      identity.productForm === "single-card" && hasConditionCertificationDimension
        ? "condition-certification-within-single-card"
        : "not-declared",
    forbiddenUnitProductForms: ["raw-card", "graded-card"],
    selectedOptionDimensions: dimensions,
    productReferenceRequiredSourceKeys,
  };
}

function validateIngestionUnitIdentity(
  identity: CatalogProviderIngestionUnitProfileIdentity,
  version: CatalogProviderIntegrationProfileVersionRecord,
): readonly CatalogProviderProfileSectionDiagnostic[] {
  const diagnostics: CatalogProviderProfileSectionDiagnostic[] = [];

  if (identity.providerKey !== version.providerKey) {
    diagnostics.push(
      diagnostic(
        "ingestion-unit-provider-mismatch",
        "ingestionUnit.providerKey",
        "Ingestion unit provider key must match the provider profile version.",
      ),
    );
  }

  let parsed: ReturnType<typeof parseCatalogIntegrationUnitKey> | null;
  try {
    parsed = parseCatalogIntegrationUnitKey(identity.unitKey);
  } catch {
    diagnostics.push(
      diagnostic(
        "ingestion-unit-invalid-key",
        "ingestionUnit.unitKey",
        "Ingestion unit key must use provider, product domain, product form, and ingestion purpose segments.",
      ),
    );
    parsed = null;
  }

  if (
    parsed &&
    (parsed.providerKey !== identity.providerKey ||
      parsed.productDomain !== identity.productDomain ||
      parsed.productForm !== identity.productForm ||
      parsed.ingestionPurpose !== identity.ingestionPurpose)
  ) {
    diagnostics.push(
      diagnostic(
        "ingestion-unit-key-mismatch",
        "ingestionUnit.unitKey",
        "Ingestion unit key must match the declared provider, product domain, product form, and ingestion purpose.",
      ),
    );
  }

  diagnostics.push(...validateRawAndGradedUnitSemantics(identity));

  return diagnostics;
}

function validateRawAndGradedUnitSemantics(
  identity: Readonly<{ productForm: string }>,
): readonly CatalogProviderProfileSectionDiagnostic[] {
  if (identity.productForm !== "raw-card" && identity.productForm !== "graded-card") {
    return [];
  }

  return [
    diagnostic(
      "raw-graded-unit-split",
      "ingestionUnit.productForm",
      "Raw and graded cards must be modeled as condition/certification semantics inside a single-card ingestion unit.",
    ),
  ];
}

function validateFixtureContract(
  fixtures: CatalogProviderIntegrationProfileVersionRecord["fixtures"],
): readonly CatalogProviderProfileSectionDiagnostic[] {
  const diagnostics: CatalogProviderProfileSectionDiagnostic[] = [];

  if (fixtures.liveProviderCallsAllowed) {
    diagnostics.push(
      diagnostic(
        "fixture-live-provider-calls",
        "fixtures.liveProviderCallsAllowed",
        "Profile fixture contracts must not require live provider calls.",
      ),
    );
  }

  for (const flow of catalogProviderRequiredFixtureFlows) {
    if (!fixtures.coveredFlows.includes(flow)) {
      diagnostics.push(
        diagnostic("fixture-missing-flow", `fixtures.coveredFlows.${flow}`, `Profile fixtures must cover ${flow}.`),
      );
    }
  }

  return diagnostics;
}

function hasMigrationEvidence(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    typeof version.migrationEvidence?.evidenceText === "string" && version.migrationEvidence.evidenceText.length > 0
  );
}

function blockedActivationChecks(
  input: CatalogProviderProfileActivationReadinessInput,
): readonly CatalogProviderProfileSectionDiagnostic[] {
  return [
    ...(!canEditCatalogProviderIngestionUnitProfile(input.lifecycle)
      ? [diagnostic("activation-mutable-lifecycle", "lifecycle", "Profile lifecycle blocks activation.")]
      : []),
    ...(!input.hasExecutableMappingContract
      ? [
          diagnostic(
            "activation-executable-mapping-contract",
            "executableMappingContract",
            "Executable mapping contract blocks activation.",
          ),
        ]
      : []),
    ...(!input.hasSourceObservationImportCapability
      ? [diagnostic("activation-import-eligibility", "profile.capabilities", "Import capability blocks activation.")]
      : []),
    ...(input.fixtureContract.liveProviderCallsAllowed
      ? [
          diagnostic(
            "activation-fixture-live-calls",
            "fixtures.liveProviderCallsAllowed",
            "Live fixture calls block activation.",
          ),
        ]
      : []),
    ...input.requiredFixtureFlows
      .filter((flow) => !input.fixtureContract.coveredFlows.includes(flow))
      .map((flow) =>
        diagnostic(
          "activation-fixture-covered-flow",
          `fixtures.coveredFlows.${flow}`,
          `${flow} coverage blocks activation.`,
        ),
      ),
    ...input.validationDiagnostics.map((entry) => toSectionDiagnostic(entry, "activation-profile-validation")),
    ...(input.migrationEvidenceRequired && !input.migrationEvidenceRecorded
      ? [
          diagnostic(
            "activation-migration-evidence",
            "migrationEvidence.evidenceText",
            "Missing migration evidence blocks activation.",
          ),
        ]
      : []),
  ];
}

function isBlockedActivationCheck(check: CatalogProviderProfileSectionDiagnostic): boolean {
  if ("status" in check && check.status === "passed") {
    return false;
  }

  return check.code.startsWith("activation-") && check.severity === "error";
}

function toSectionDiagnostic(
  diagnosticEntry: CatalogProviderIntegrationProfileVersionDiagnostic,
  code?: string,
): CatalogProviderProfileSectionDiagnostic {
  return diagnostic(code ?? diagnosticEntry.code, diagnosticEntry.path, diagnosticEntry.diagnosticText);
}

function diagnostic(code: string, path: string, diagnosticText: string): CatalogProviderProfileSectionDiagnostic {
  return {
    code,
    path,
    diagnosticText,
    severity: "error",
  };
}
