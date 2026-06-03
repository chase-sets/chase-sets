import type { JsonValue } from "@chase-sets/primitives/json";

export type CatalogProviderProfileLifecycle = "draft" | "test" | "active" | "deprecated" | "retired";

export type CatalogProviderMappingEvidenceOwner =
  | "catalog-truth"
  | "catalog-merge-evidence"
  | "external-reference"
  | "pricing-signal"
  | "inventory-signal"
  | "operations"
  | "excluded";

export type CatalogProviderMappingEvidenceUse =
  | "source-payload"
  | "normalized-observation"
  | "hash-material"
  | "merge-identity"
  | "external-reference"
  | "selected-option"
  | "reference-hierarchy"
  | "promotion-command";

export type CatalogProviderMappingSourceContract = Readonly<{
  owner: string;
  repository: string | null;
  commit: string | null;
  documentPath: string;
  fixtureSetVersion: string;
}>;

export type CatalogProviderMappingConnectorContract = Readonly<{
  kind: string;
  transportOwns: readonly (
    | "auth"
    | "domains"
    | "endpoint-paths"
    | "pagination"
    | "throttling"
    | "raw-provider-parse"
  )[];
  mappingOwns: readonly CatalogProviderMappingEvidenceUse[];
}>;

export type CatalogProviderProfileFixtureFlow =
  | "normal"
  | "partial"
  | "stale"
  | "changed"
  | "ambiguous"
  | "replay"
  | "sealed-product"
  | "unknown-option";

export const catalogProviderRequiredFixtureFlows = [
  "normal",
  "partial",
  "stale",
  "changed",
  "ambiguous",
  "replay",
  "sealed-product",
  "unknown-option",
] as const satisfies readonly CatalogProviderProfileFixtureFlow[];

export type CatalogProviderProfileFixtureContract = Readonly<{
  fixtureRoot: string;
  coveredFlows: readonly CatalogProviderProfileFixtureFlow[];
  liveProviderCallsAllowed: false;
}>;

export type CatalogProviderMappingSelector =
  | CatalogProviderPathSelector
  | CatalogProviderConstantSelector
  | CatalogProviderCoalesceSelector
  | CatalogProviderObjectSelector
  | CatalogProviderArrayMapSelector
  | CatalogProviderNamedRuntimeSelector;

export type CatalogProviderPathSelector = Readonly<{
  kind: "path";
  path: string;
  required: boolean;
  nullPolicy: "allow-null" | "omit" | "diagnostic";
}>;

export type CatalogProviderConstantSelector = Readonly<{
  kind: "constant";
  value: JsonValue;
}>;

export type CatalogProviderCoalesceSelector = Readonly<{
  kind: "coalesce";
  selectors: readonly CatalogProviderMappingSelector[];
  required: boolean;
}>;

export type CatalogProviderObjectSelector = Readonly<{
  kind: "object";
  fields: Readonly<Record<string, CatalogProviderMappingValueExpression>>;
}>;

export type CatalogProviderArrayMapSelector = Readonly<{
  kind: "array-map";
  path: string;
  item: CatalogProviderMappingValueExpression;
  emptyPolicy: "allow-empty" | "diagnostic";
}>;

export type CatalogProviderNamedRuntimeSelector = Readonly<{
  kind: "named-runtime-selector";
  functionKey: CatalogProviderMappingRuntimeFunctionKey;
  reason: string;
}>;

export type CatalogProviderMappingTransform =
  | CatalogProviderNamedTransform
  | CatalogProviderCoerceTransform
  | CatalogProviderStringTransform
  | CatalogProviderLookupTransform;

export type CatalogProviderNamedTransform = Readonly<{
  kind: "named-transform";
  functionKey: CatalogProviderMappingRuntimeFunctionKey;
  reason: string;
}>;

export type CatalogProviderCoerceTransform = Readonly<{
  kind: "coerce";
  to: "string" | "number" | "boolean" | "json-object" | "json-array";
}>;

export type CatalogProviderStringTransform = Readonly<{
  kind: "string";
  operation: "trim" | "lowercase" | "uppercase" | "slug" | "normalize-provider-option";
}>;

export type CatalogProviderLookupTransform = Readonly<{
  kind: "lookup";
  tableKey: string;
  unknownPolicy: "diagnostic" | "review-evidence" | "omit";
}>;

export type CatalogProviderMappingRuntimeFunctionKey =
  | "tcgdex-card-variant-expander"
  | "tcgdex-marketplace-reference-extractor"
  | "tcgdex-pokemon-reference-hierarchy"
  | "tcgdex-pokemon-promotion-command-plan"
  | "tcgplayer-sku-selected-option-resolver"
  | "scrydex-tcgplayer-id-reference-extractor";

export type CatalogProviderMappingValueExpression = Readonly<{
  selector: CatalogProviderMappingSelector;
  transforms?: readonly CatalogProviderMappingTransform[];
  owner: CatalogProviderMappingEvidenceOwner;
  uses: readonly CatalogProviderMappingEvidenceUse[];
  redaction: "none" | "secret" | "seller" | "price" | "operations";
}>;

export type CatalogProviderNormalizedObservationContract = Readonly<{
  outputKind: "pokemon-card" | "provider-product";
  languageCode: CatalogProviderMappingValueExpression;
  fields: Readonly<Record<string, CatalogProviderMappingValueExpression>>;
  hashMaterial: readonly CatalogProviderMappingValueExpression[];
  mergeIdentity: readonly CatalogProviderMappingValueExpression[];
}>;

export type CatalogProviderExternalReferenceContract = Readonly<{
  target: "catalog-item-reference" | "product-reference";
  providerKey: string;
  externalKeyPrefix: string;
  source: CatalogProviderMappingValueExpression;
  selectedOptions?: CatalogProviderSelectedOptionContract;
  ambiguityPolicy: "skip-reference" | "diagnostic" | "review-evidence";
}>;

export type CatalogProviderSelectedOptionContract = Readonly<{
  dimensions: readonly CatalogProviderSelectedOptionDimensionContract[];
  missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence" | "diagnostic";
}>;

export type CatalogProviderSelectedOptionDimensionContract = Readonly<{
  dimensionKey: string;
  providerValue: CatalogProviderMappingValueExpression;
  optionLookupTableKey: string;
  required: boolean;
}>;

export type CatalogProviderReferenceHierarchyContract = Readonly<{
  targetTypeKey: string;
  providerAttributeKey: string;
  referenceRecordKey: CatalogProviderMappingValueExpression;
  parent?: CatalogProviderReferenceHierarchyContract;
}>;

export type CatalogProviderDuplicatePreventionContract = Readonly<{
  exactExternalCatalogItemReferencesFirst: boolean;
  mergeCandidateEvidence: readonly CatalogProviderMappingValueExpression[];
  ambiguousCandidatePolicy: "block-promotion" | "review-only";
  replayPolicy: "same-profile-version" | "operator-reapply-active-version";
}>;

export type CatalogProviderPromotionCommandPlanContract = Readonly<{
  planKind: "catalog-item-promotion";
  requiresReview: true;
  commands: readonly CatalogProviderPromotionCommandContract[];
}>;

export type CatalogProviderPromotionCommandContract = Readonly<{
  commandName:
    | "CreateCatalogItem"
    | "RefreshCatalogItem"
    | "AssignBlueprintToCatalogItem"
    | "SetCatalogItemFieldValue"
    | "SetCatalogItemTags"
    | "SetCatalogItemProductAssetSets"
    | "LinkExternalCatalogItemReference"
    | "LinkExternalProductReference";
  inputs: Readonly<Record<string, CatalogProviderMappingValueExpression>>;
}>;

export type CatalogProviderExecutableMappingContract = Readonly<{
  providerKey: string;
  profileKey: string;
  displayName: string;
  profileVersion: string;
  lifecycle: CatalogProviderProfileLifecycle;
  sourceContract: CatalogProviderMappingSourceContract;
  connector: CatalogProviderMappingConnectorContract;
  fixtures: CatalogProviderProfileFixtureContract;
  normalizedObservation: CatalogProviderNormalizedObservationContract;
  externalReferences: readonly CatalogProviderExternalReferenceContract[];
  referenceHierarchy: readonly CatalogProviderReferenceHierarchyContract[];
  duplicatePrevention: CatalogProviderDuplicatePreventionContract;
  promotionCommandPlan: CatalogProviderPromotionCommandPlanContract;
  nonGoals: readonly CatalogProviderProfileNonGoal[];
}>;

export type CatalogProviderProfileNonGoal =
  | "no-live-provider-calls-in-mapping-tests"
  | "no-pricing-facts-as-catalog-truth"
  | "no-inventory-facts-as-global-catalog-truth"
  | "no-provider-secrets-in-events-logs-or-fixtures"
  | "no-provider-transport-branches-in-mapping-interpreter";

export type CatalogProviderMappingContractDiagnostic = Readonly<{
  code:
    | "missing-profile-version"
    | "missing-fixture-flow"
    | "live-provider-calls-in-fixtures"
    | "unsafe-owner-for-catalog-use"
    | "secret-used-as-catalog-fact";
  path: string;
  diagnosticText: string;
}>;

export function validateCatalogProviderExecutableMappingContract(
  contract: CatalogProviderExecutableMappingContract,
): readonly CatalogProviderMappingContractDiagnostic[] {
  const diagnostics: CatalogProviderMappingContractDiagnostic[] = [];

  if (contract.profileVersion.trim().length === 0) {
    diagnostics.push({
      code: "missing-profile-version",
      path: "profileVersion",
      diagnosticText: "Provider mapping profiles must carry a version for replay and rollback.",
    });
  }

  if (contract.fixtures.liveProviderCallsAllowed) {
    diagnostics.push({
      code: "live-provider-calls-in-fixtures",
      path: "fixtures.liveProviderCallsAllowed",
      diagnosticText: "Provider mapping fixtures must not require live provider calls.",
    });
  }

  for (const flow of catalogProviderRequiredFixtureFlows) {
    if (!contract.fixtures.coveredFlows.includes(flow)) {
      diagnostics.push({
        code: "missing-fixture-flow",
        path: "fixtures.coveredFlows",
        diagnosticText: `Provider mapping fixtures must cover the ${flow} flow.`,
      });
    }
  }

  validateExpression("normalizedObservation.languageCode", contract.normalizedObservation.languageCode, diagnostics);
  for (const [fieldKey, expression] of Object.entries(contract.normalizedObservation.fields)) {
    validateExpression(`normalizedObservation.fields.${fieldKey}`, expression, diagnostics);
  }
  contract.normalizedObservation.hashMaterial.forEach((expression, index) =>
    validateExpression(`normalizedObservation.hashMaterial.${index}`, expression, diagnostics),
  );
  contract.normalizedObservation.mergeIdentity.forEach((expression, index) =>
    validateExpression(`normalizedObservation.mergeIdentity.${index}`, expression, diagnostics),
  );
  contract.externalReferences.forEach((reference, index) => {
    validateExpression(`externalReferences.${index}.source`, reference.source, diagnostics);
    reference.selectedOptions?.dimensions.forEach((dimension, dimensionIndex) =>
      validateExpression(
        `externalReferences.${index}.selectedOptions.dimensions.${dimensionIndex}.providerValue`,
        dimension.providerValue,
        diagnostics,
      ),
    );
  });
  contract.referenceHierarchy.forEach((reference, index) =>
    validateReferenceHierarchy(`referenceHierarchy.${index}`, reference, diagnostics),
  );
  contract.duplicatePrevention.mergeCandidateEvidence.forEach((expression, index) =>
    validateExpression(`duplicatePrevention.mergeCandidateEvidence.${index}`, expression, diagnostics),
  );
  contract.promotionCommandPlan.commands.forEach((command, commandIndex) => {
    for (const [inputKey, expression] of Object.entries(command.inputs)) {
      validateExpression(`promotionCommandPlan.commands.${commandIndex}.inputs.${inputKey}`, expression, diagnostics);
    }
  });

  return diagnostics;
}

function validateReferenceHierarchy(
  path: string,
  reference: CatalogProviderReferenceHierarchyContract,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  validateExpression(`${path}.referenceRecordKey`, reference.referenceRecordKey, diagnostics);
  if (reference.parent) {
    validateReferenceHierarchy(`${path}.parent`, reference.parent, diagnostics);
  }
}

function validateExpression(
  path: string,
  expression: CatalogProviderMappingValueExpression,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  const catalogUse = expression.uses.some(
    (use) =>
      use === "normalized-observation" ||
      use === "hash-material" ||
      use === "merge-identity" ||
      use === "external-reference" ||
      use === "selected-option" ||
      use === "reference-hierarchy" ||
      use === "promotion-command",
  );
  const disallowedOwner =
    expression.owner === "pricing-signal" ||
    expression.owner === "inventory-signal" ||
    expression.owner === "operations" ||
    expression.owner === "excluded";

  if (catalogUse && disallowedOwner) {
    diagnostics.push({
      code: "unsafe-owner-for-catalog-use",
      path,
      diagnosticText: `${expression.owner} evidence cannot be used as Catalog mapping truth.`,
    });
  }

  if (catalogUse && expression.redaction === "secret") {
    diagnostics.push({
      code: "secret-used-as-catalog-fact",
      path,
      diagnosticText: "Secret provider evidence cannot be used in Catalog mapping facts.",
    });
  }
}
