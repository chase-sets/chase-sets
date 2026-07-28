import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import { defineCatalogIntegrationUnitKey, parseCatalogIntegrationUnitKey } from "../governance/integration-unit";
import {
  decideCatalogAliasAcceptance,
  getCatalogAliasSourceGovernancePolicy,
  isRejectedNonEnglishLanguageCode,
  type CatalogAliasSourceCategoryKey,
  type CatalogAliasTypeKey,
} from "../governance/catalog-integration-data-governance";

export type CatalogProviderProfileLifecycle = "draft" | "test" | "active" | "deprecated" | "retired";

export type CatalogProviderIngestionUnitProductDomain = "pokemon" | "mtg" | "yugioh" | "one-piece" | "lorcana";
export type CatalogProviderIngestionUnitProductForm = "single-card" | "sealed-product" | "set" | "pack";
export type CatalogProviderIngestionPurpose = "source-observation-import" | "reference-data" | "image-evidence";

export type CatalogProviderIngestionUnitIdentityContract = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  productDomain: CatalogProviderIngestionUnitProductDomain;
  productForm: CatalogProviderIngestionUnitProductForm;
  ingestionPurpose: CatalogProviderIngestionPurpose;
}>;

export type CatalogProviderMappingEvidenceOwner =
  | "catalog-truth"
  | "catalog-merge-evidence"
  | "catalog-alias-evidence"
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
  | "alias-candidate"
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
    | "request-pacing"
    | "cache-policy"
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
  liveProviderCallsAllowed: boolean;
}>;

export type CatalogProviderMappingSelector =
  | CatalogProviderPathSelector
  | CatalogProviderConstantSelector
  | CatalogProviderCoalesceSelector
  | CatalogProviderTemplateSelector
  | CatalogProviderArraySelector
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

export type CatalogProviderTemplateSelector = Readonly<{
  kind: "template";
  template: string;
  values: Readonly<Record<string, CatalogProviderMappingValueExpression>>;
  required: boolean;
}>;

export type CatalogProviderArraySelector = Readonly<{
  kind: "array";
  items: readonly CatalogProviderMappingValueExpression[];
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
  | "tcgplayer-product-barcode"
  | "tcgplayer-product-form"
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
  outputKind:
    | "pokemon-card"
    | "pokemon-sealed-product"
    | "provider-product"
    | "magic-card-print"
    | "magic-set-reference"
    | "magic-sealed-product"
    | "yugioh-card-print"
    | "yugioh-set-reference"
    | "yugioh-sealed-product"
    | "yugioh-pack-reference"
    | "one-piece-card-print"
    | "one-piece-set-reference"
    | "one-piece-sealed-product"
    | "lorcana-card-print"
    | "lorcana-set-reference"
    | "lorcana-sealed-product";
  languageCode: CatalogProviderMappingValueExpression;
  fields: Readonly<Record<string, CatalogProviderMappingValueExpression>>;
  hashMaterial: readonly CatalogProviderMappingValueExpression[];
  mergeIdentity: readonly CatalogProviderMappingValueExpression[];
}>;

export type CatalogProviderSourceObservationContract = Readonly<{
  observationId: CatalogProviderMappingValueExpression;
  externalKey: CatalogProviderMappingValueExpression;
  sourceUrl: CatalogProviderMappingValueExpression;
  sourceUpdatedAt: CatalogProviderMappingValueExpression;
  sourcePayload: CatalogProviderMappingValueExpression;
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

// ---------------------------------------------------------------------------
// Alias candidate extraction
//
// Declares, as data, how a provider mapping produces an `Alias Candidate`: a
// reviewable claim that a piece of provider text is an equivalent name for a
// Catalog Item or Reference Record. The alias type, source category, and
// acceptance disposition are owned by the alias source-governance policy
// (`catalog-integration-data-governance.ts`); this contract references those
// exports rather than declaring a parallel policy. No provider-specific runtime
// branch is required: a profile declares alias extraction the same way it
// declares selected options or external references.
// ---------------------------------------------------------------------------

/**
 * What an extracted alias candidate is an equivalent name for. Catalog Items are
 * the default; `set-equivalent` / `series-equivalent` aliases operate at the
 * Reference Record level (expansion and series) per the ADR.
 */
export type CatalogProviderAliasCandidateTargetKind = "catalog-item" | "reference-record";

export type CatalogProviderAliasCandidateTarget =
  | Readonly<{ kind: "catalog-item"; catalogItemFieldKey: string }>
  | Readonly<{ kind: "reference-record"; referenceTypeKey: string }>;

/**
 * How the alias candidate decides confidence and whether it may auto-accept.
 * The `sourceCategory` is governed by the alias source-governance policy; the
 * profile never invents its own auto-accept rule. `reviewPolicy` records the
 * authoring intent and must agree with what the governed category permits:
 * `governed-auto-accept` is only valid for categories whose acceptance policy is
 * `auto-accept`; every other category must declare `always-review`.
 */
export type CatalogProviderAliasCandidateConfidencePolicy = Readonly<{
  sourceCategory: CatalogAliasSourceCategoryKey;
  reviewPolicy: "governed-auto-accept" | "always-review";
}>;

export type CatalogProviderAliasCandidateContract = Readonly<{
  aliasCandidateKey: string;
  target: CatalogProviderAliasCandidateTarget;
  aliasType: CatalogAliasTypeKey;
  /** Provider text expression that yields the alias name. */
  aliasText: CatalogProviderMappingValueExpression;
  /** Language of the alias text (BCP-47-style code, e.g. "fr", "ja"). */
  aliasLanguage: CatalogProviderAliasCandidateLanguage;
  /** Language of the canonical name the alias is an equivalent of, when known. */
  sourceLanguage?: CatalogProviderAliasCandidateLanguage;
  confidencePolicy: CatalogProviderAliasCandidateConfidencePolicy;
  /** Supporting evidence expression (e.g. shared provider id) backing the alias. */
  evidence: CatalogProviderMappingValueExpression;
  /** What to do when alias text resolves but no supporting evidence is present. */
  missingEvidencePolicy: "diagnostic" | "review-evidence";
  /** What to do when the alias text itself cannot be resolved. */
  unknownAliasTextPolicy: "diagnostic" | "omit";
}>;

export type CatalogProviderAliasCandidateLanguage =
  | Readonly<{ kind: "static"; languageCode: string }>
  | Readonly<{ kind: "path"; path: string; required: boolean }>;

export type CatalogProviderDuplicatePreventionContract = Readonly<{
  exactExternalCatalogItemReferencesFirst: boolean;
  mergeCandidateEvidence: readonly CatalogProviderMappingValueExpression[];
  identityRules: readonly CatalogProviderDuplicatePreventionIdentityRuleContract[];
  ambiguousCandidatePolicy: "block-promotion" | "review-only";
  replayPolicy: "same-profile-version" | "operator-reapply-active-version";
}>;

export type CatalogProviderDuplicatePreventionIdentityRuleContract = Readonly<{
  ruleKey: string;
  ruleKind:
    | "exact-external-catalog-item-reference"
    | "exact-external-product-reference"
    | "source-observation-link"
    | "deterministic-field-match"
    | "sealed-product-match"
    | "barcode-gtin-match"
    | "future-provider-bridge-match";
  evidence: readonly CatalogProviderMappingValueExpression[];
  candidatePolicy: "reuse" | "review-only";
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
    | "ReviseCatalogItemMetadata"
    | "AssignBlueprintToCatalogItem"
    | "AssignCatalogItemToCategory"
    | "SetCatalogItemFieldValue"
    | "SetCatalogItemTags"
    | "SetCatalogItemImageUrls"
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
  ingestionUnitIdentity?: CatalogProviderIngestionUnitIdentityContract;
  lifecycle: CatalogProviderProfileLifecycle;
  sourceContract: CatalogProviderMappingSourceContract;
  connector: CatalogProviderMappingConnectorContract;
  fixtures: CatalogProviderProfileFixtureContract;
  sourceObservation?: CatalogProviderSourceObservationContract;
  normalizedObservation: CatalogProviderNormalizedObservationContract;
  externalReferences: readonly CatalogProviderExternalReferenceContract[];
  referenceHierarchy: readonly CatalogProviderReferenceHierarchyContract[];
  aliasCandidates?: readonly CatalogProviderAliasCandidateContract[];
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
    | "ingestion-unit-provider-mismatch"
    | "ingestion-unit-key-mismatch"
    | "ingestion-unit-invalid-key"
    | "missing-profile-version"
    | "missing-fixture-flow"
    | "live-provider-calls-in-fixtures"
    | "unsafe-owner-for-catalog-use"
    | "secret-used-as-catalog-fact"
    | "alias-candidate-missing-text"
    | "alias-candidate-invalid-type"
    | "alias-candidate-invalid-language"
    | "alias-candidate-invalid-target"
    | "alias-candidate-unsupported-confidence-policy";
  path: string;
  diagnosticText: string;
}>;

export function defineCatalogProviderIngestionUnitIdentityContract(
  input: Readonly<{
    providerKey: string;
    productDomain: CatalogProviderIngestionUnitProductDomain;
    productForm: CatalogProviderIngestionUnitProductForm;
    ingestionPurpose: CatalogProviderIngestionPurpose;
  }>,
): CatalogProviderIngestionUnitIdentityContract {
  const unitKey = defineCatalogIntegrationUnitKey(input);
  const parsed = parseCatalogIntegrationUnitKey(unitKey);

  return {
    unitKey,
    providerKey: parsed.providerKey,
    productDomain: parsed.productDomain as CatalogProviderIngestionUnitProductDomain,
    productForm: parsed.productForm as CatalogProviderIngestionUnitProductForm,
    ingestionPurpose: parsed.ingestionPurpose as CatalogProviderIngestionPurpose,
  };
}

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

  if (contract.ingestionUnitIdentity) {
    validateIngestionUnitIdentity("ingestionUnitIdentity", contract, diagnostics);
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
  if (contract.sourceObservation) {
    validateExpression("sourceObservation.observationId", contract.sourceObservation.observationId, diagnostics);
    validateExpression("sourceObservation.externalKey", contract.sourceObservation.externalKey, diagnostics);
    validateExpression("sourceObservation.sourceUrl", contract.sourceObservation.sourceUrl, diagnostics);
    validateExpression("sourceObservation.sourceUpdatedAt", contract.sourceObservation.sourceUpdatedAt, diagnostics);
    validateExpression("sourceObservation.sourcePayload", contract.sourceObservation.sourcePayload, diagnostics);
  }
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
  (contract.aliasCandidates ?? []).forEach((aliasCandidate, index) =>
    validateAliasCandidate(`aliasCandidates.${index}`, aliasCandidate, diagnostics),
  );
  contract.duplicatePrevention.mergeCandidateEvidence.forEach((expression, index) =>
    validateExpression(`duplicatePrevention.mergeCandidateEvidence.${index}`, expression, diagnostics),
  );
  contract.duplicatePrevention.identityRules.forEach((rule, ruleIndex) =>
    rule.evidence.forEach((expression, evidenceIndex) =>
      validateExpression(
        `duplicatePrevention.identityRules.${ruleIndex}.evidence.${evidenceIndex}`,
        expression,
        diagnostics,
      ),
    ),
  );
  contract.promotionCommandPlan.commands.forEach((command, commandIndex) => {
    for (const [inputKey, expression] of Object.entries(command.inputs)) {
      validateExpression(`promotionCommandPlan.commands.${commandIndex}.inputs.${inputKey}`, expression, diagnostics);
    }
  });

  return diagnostics;
}

function validateIngestionUnitIdentity(
  path: string,
  contract: CatalogProviderExecutableMappingContract,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  const identity = contract.ingestionUnitIdentity;
  if (!identity) {
    return;
  }

  if (identity.providerKey !== contract.providerKey) {
    diagnostics.push({
      code: "ingestion-unit-provider-mismatch",
      path: `${path}.providerKey`,
      diagnosticText: "The ingestion unit provider key must match the executable mapping contract provider key.",
    });
  }

  let parsed: ReturnType<typeof parseCatalogIntegrationUnitKey>;
  try {
    parsed = parseCatalogIntegrationUnitKey(identity.unitKey);
  } catch {
    diagnostics.push({
      code: "ingestion-unit-invalid-key",
      path: `${path}.unitKey`,
      diagnosticText: "The ingestion unit key must be a valid provider:domain:form:purpose key.",
    });
    return;
  }

  if (
    parsed.providerKey !== identity.providerKey ||
    parsed.productDomain !== identity.productDomain ||
    parsed.productForm !== identity.productForm ||
    parsed.ingestionPurpose !== identity.ingestionPurpose
  ) {
    diagnostics.push({
      code: "ingestion-unit-key-mismatch",
      path: `${path}.unitKey`,
      diagnosticText:
        "The ingestion unit key must match the declared provider, product domain, product form, and ingestion purpose.",
    });
  }
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

/**
 * Alias types that operate at the Reference Record level (expansion and series)
 * per the ADR. Every other alias type operates at the Catalog Item level.
 */
const referenceRecordAliasTypes: readonly CatalogAliasTypeKey[] = ["set-equivalent", "series-equivalent"];

const knownAliasTypes: readonly CatalogAliasTypeKey[] = [
  "official-equivalent",
  "provider-localized-name",
  "species-name",
  "literal-translation",
  "romanization",
  "generated-translation",
  "set-equivalent",
  "series-equivalent",
];

function validateAliasCandidate(
  path: string,
  aliasCandidate: CatalogProviderAliasCandidateContract,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  validateExpression(`${path}.aliasText`, aliasCandidate.aliasText, diagnostics);
  validateExpression(`${path}.evidence`, aliasCandidate.evidence, diagnostics);

  // Missing alias text: the alias text selector resolves to nothing usable.
  if (aliasTextIsMissing(aliasCandidate.aliasText)) {
    diagnostics.push({
      code: "alias-candidate-missing-text",
      path: `${path}.aliasText`,
      diagnosticText: "An alias candidate must declare a provider expression that yields the alias text.",
    });
  }

  // Invalid alias type: not a known ADR alias type.
  if (!knownAliasTypes.includes(aliasCandidate.aliasType)) {
    diagnostics.push({
      code: "alias-candidate-invalid-type",
      path: `${path}.aliasType`,
      diagnosticText: `Alias type '${aliasCandidate.aliasType}' is not a known Catalog Alias type.`,
    });
    return;
  }

  // Invalid target: target kind and alias-type level must agree, and the target
  // must name its field/reference type.
  validateAliasCandidateTarget(path, aliasCandidate, diagnostics);

  // Invalid language: empty static codes, and non-English codes used for an
  // English-only alias type (TCGdex `id` is Indonesian and is never English).
  validateAliasCandidateLanguage(`${path}.aliasLanguage`, aliasCandidate.aliasLanguage, aliasCandidate, diagnostics);
  if (aliasCandidate.sourceLanguage) {
    validateAliasCandidateLanguage(
      `${path}.sourceLanguage`,
      aliasCandidate.sourceLanguage,
      aliasCandidate,
      diagnostics,
    );
  }

  // Unsupported confidence/review policy: the source category must be able to
  // produce this alias type, and the declared review policy must agree with the
  // governed acceptance disposition.
  validateAliasCandidateConfidencePolicy(path, aliasCandidate, diagnostics);
}

function validateAliasCandidateTarget(
  path: string,
  aliasCandidate: CatalogProviderAliasCandidateContract,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  const target = aliasCandidate.target;
  const aliasTypeIsReferenceLevel = referenceRecordAliasTypes.includes(aliasCandidate.aliasType);

  if (target.kind === "catalog-item") {
    if (aliasTypeIsReferenceLevel) {
      diagnostics.push({
        code: "alias-candidate-invalid-target",
        path: `${path}.target`,
        diagnosticText: `Alias type '${aliasCandidate.aliasType}' targets a Reference Record, not a Catalog Item.`,
      });
    }
    if (target.catalogItemFieldKey.trim().length === 0) {
      diagnostics.push({
        code: "alias-candidate-invalid-target",
        path: `${path}.target.catalogItemFieldKey`,
        diagnosticText: "A Catalog Item alias target must name the Catalog Item field it aliases.",
      });
    }
    return;
  }

  if (!aliasTypeIsReferenceLevel) {
    diagnostics.push({
      code: "alias-candidate-invalid-target",
      path: `${path}.target`,
      diagnosticText: `Alias type '${aliasCandidate.aliasType}' targets a Catalog Item, not a Reference Record.`,
    });
  }
  if (target.referenceTypeKey.trim().length === 0) {
    diagnostics.push({
      code: "alias-candidate-invalid-target",
      path: `${path}.target.referenceTypeKey`,
      diagnosticText: "A Reference Record alias target must name the reference type it aliases.",
    });
  }
}

function validateAliasCandidateLanguage(
  path: string,
  language: CatalogProviderAliasCandidateLanguage,
  aliasCandidate: CatalogProviderAliasCandidateContract,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  if (language.kind === "path") {
    if (language.path.trim().length === 0) {
      diagnostics.push({
        code: "alias-candidate-invalid-language",
        path: `${path}.path`,
        diagnosticText: "An alias language path must reference a provider field.",
      });
    }
    return;
  }

  const languageCode = language.languageCode.trim();
  if (languageCode.length === 0) {
    diagnostics.push({
      code: "alias-candidate-invalid-language",
      path: `${path}.languageCode`,
      diagnosticText: "An alias language code must not be empty.",
    });
    return;
  }

  // An English official equivalent can never be carried by the TCGdex `id`
  // (Indonesian) language code.
  if (aliasCandidate.aliasType === "official-equivalent" && isRejectedNonEnglishLanguageCode(languageCode)) {
    diagnostics.push({
      code: "alias-candidate-invalid-language",
      path: `${path}.languageCode`,
      diagnosticText: `Language code '${languageCode}' is Indonesian and is never valid English evidence for an official equivalent.`,
    });
  }
}

function validateAliasCandidateConfidencePolicy(
  path: string,
  aliasCandidate: CatalogProviderAliasCandidateContract,
  diagnostics: CatalogProviderMappingContractDiagnostic[],
): void {
  const { sourceCategory, reviewPolicy } = aliasCandidate.confidencePolicy;
  const policy = getCatalogAliasSourceGovernancePolicy(sourceCategory);

  if (!policy.producibleAliasTypes.includes(aliasCandidate.aliasType)) {
    diagnostics.push({
      code: "alias-candidate-unsupported-confidence-policy",
      path: `${path}.confidencePolicy.sourceCategory`,
      diagnosticText: `Source category '${sourceCategory}' cannot produce alias type '${aliasCandidate.aliasType}'.`,
    });
    return;
  }

  const decision = decideCatalogAliasAcceptance({ category: sourceCategory });
  const governedAllowsAutoAccept = decision.reviewState === "auto-accepted";

  if (reviewPolicy === "governed-auto-accept" && !governedAllowsAutoAccept) {
    diagnostics.push({
      code: "alias-candidate-unsupported-confidence-policy",
      path: `${path}.confidencePolicy.reviewPolicy`,
      diagnosticText: `Source category '${sourceCategory}' does not permit auto-accept and must declare 'always-review'.`,
    });
  }
}

function aliasTextIsMissing(expression: CatalogProviderMappingValueExpression): boolean {
  const selector = expression.selector;
  if (selector.kind === "path") {
    return selector.path.trim().length === 0;
  }
  if (selector.kind === "constant") {
    return typeof selector.value !== "string" || selector.value.trim().length === 0;
  }
  if (selector.kind === "template") {
    return selector.template.trim().length === 0;
  }
  return false;
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
      use === "alias-candidate" ||
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
