import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { JsonValue } from "@chase-sets/primitives/json";
import { useEffect, useMemo, useState } from "react";
import { useRevalidator } from "react-router";
import {
  Button,
  ActionBar,
  Cluster,
  Combobox,
  DataTable,
  Dialog,
  FilterBar,
  Inline,
  KeyValueList,
  LinkButton,
  Page,
  PageHeader,
  ProgressBar,
  SegmentedControl,
  Select,
  Stack,
  Stat,
  StatGrid,
  StatusPill,
  OperationalStatusBanner,
  TaskSummary,
  TextInput,
  Textarea,
  type DataColumn,
  type SegmentedControlItem,
  type SelectItem,
} from "@chase-sets/design-system";
import {
  type CatalogListRouteData,
  useCatalogListQueryControls,
} from "../../../support/shell-support/list-query-state";
import type { CatalogBulkActionProgress, CatalogIntegrationJob } from "../../../support/shell-support/api/client";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import type {
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileBasicsUpdateCommand,
  CatalogProviderProfileConnectorUpdateCommand,
  CatalogProviderProfileDryRunResult,
  CatalogProviderProfileDuplicatePreventionUpdateCommand,
  CatalogProviderProfileFixturesUpdateCommand,
  CatalogProviderProfileExternalReferencesUpdateCommand,
  CatalogProviderProfileNormalizedObservationUpdateCommand,
  CatalogProviderProfileProviderOptionsUpdateCommand,
  CatalogProviderProfilePromotionPlanUpdateCommand,
  CatalogProviderProfileReferenceHierarchyUpdateCommand,
  CatalogProviderProfileRetirementPlanUpdateCommand,
  CatalogProviderProfileSelectedOptionsUpdateCommand,
  CatalogProviderProfileSourceContractUpdateCommand,
  CatalogProviderProfileVersionReview,
  BulkSourceObservationPromotionResult,
  SourceObservationIntegrationOption,
  SourceObservationIntegrationJobOutcome,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationScope,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
  SourceObservationReapplyPreview,
} from "./contracts";
import {
  activateSourceObservationProviderProfile,
  bulkPromoteSourceObservationsByScope,
  cloneSourceObservationProviderProfile,
  deprecateSourceObservationProviderProfile,
  dryRunSourceObservationProviderProfile,
  enqueueSourceObservationIntegrationJob,
  previewBulkPromoteSourceObservations,
  previewReapplySourceObservations,
  retireSourceObservationProviderProfile,
  rollbackSourceObservationProviderProfile,
  updateSourceObservationProviderProfileSection,
  useActiveSourceObservationIntegrationJobs,
  useCatalogIntegrationControlPlaneReadiness,
  useSourceObservationProviderProfileAuthoringModel,
  useSourceObservationProviderProfiles,
  useSourceObservationIntegrationOptions,
  watchSourceObservationIntegrationJob,
} from "./use-source-observations";
import { shouldAcceptSourceObservationJobProgress } from "./job-progress";
import {
  MappingExpressionEditor,
  defaultExpression,
  previewMappingExpression,
  validateMappingExpression,
  type MappingExpressionValue,
} from "./mapping-expression-editor";
import { CatalogIntegrationProfileHealthPanel } from "./admin-control-plane/health/integration-health-dashboard";
import { CatalogIntegrationAreaWorkbench } from "./admin-control-plane/profiles/profile-workflow-workbench";
import type { CatalogIntegrationModuleArea } from "./admin-control-plane/registry";
import { CatalogIntegrationModuleShell } from "./admin-control-plane/shell/catalog-integration-module-shell";

const ALL_PROVIDERS = "__all__";
const ALL_LANGUAGES = "__all__";
const ALL_EXPANSIONS = "__all__";
const ALL_SERIES = "__all__";
const NO_PROFILE_WORKSPACE = "__no_profile_workspace__";
const TCGDEX_PROVIDER = "tcgdex";
const TCGPLAYER_PROVIDER = "tcgplayer";
const TCGPLAYER_PRODUCT_LINE_SCOPE = "product-line";
const TCGPLAYER_PRODUCT_SCOPE = "product";
const ALL_TCGPLAYER_SETS = "__all_tcgplayer_sets__";

type LastIntegrationJobResultSummary = {
  action: "import" | "reapply";
  scope: SourceObservationIntegrationJobScope;
  result: SourceObservationIntegrationJobResult;
};

type LastPromotionResultSummary = {
  scope: SourceObservationPromotionScope;
  result: BulkSourceObservationPromotionResult;
};

type IntegrationFailureGroup = {
  reason: string;
  count: number;
  examples: readonly { label: string; href: string }[];
};
const CATALOG_PROVIDER_CAPABILITY_OPTIONS = [
  "provider-option-query",
  "source-observation-import",
  "catalog-item-promotion",
  "external-reference-extraction",
] as const;
const CATALOG_PROVIDER_SCOPE_OPTIONS = [
  "language",
  "series",
  "expansion",
  "product/card",
  "product-line/category",
  "set-name",
  "product",
  "sku",
] as const;
const REQUIRED_FIXTURE_FLOW_OPTIONS = [
  "normal",
  "partial",
  "stale",
  "changed",
  "ambiguous",
  "replay",
  "sealed-product",
  "unknown-option",
] as const;
const PROFILE_COMPATIBILITY_MODE_OPTIONS = [
  {
    value: "executable-mapping-contract",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.executable.mapping.contract"),
  },
  {
    value: "transitional-static-profile",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.transitional.static.profile"),
  },
] satisfies SelectItem[];
const PROFILE_STATUS_OPTIONS = [
  { value: "active", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.active") },
  { value: "planned", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.planned") },
] satisfies SelectItem[];
const PROFILE_LIFECYCLE_OPTIONS = [
  { value: "draft", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.draft") },
  { value: "test", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.test") },
] satisfies SelectItem[];
const EMPTY_PROFILE_REVIEWS: CatalogProviderProfileVersionReview[] = [];
const OPTION_QUERY_OPERATION_OPTIONS = [
  {
    value: "tcgdex-list-languages",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgdex.languages"),
  },
  {
    value: "tcgdex-list-series",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgdex.series"),
  },
  {
    value: "tcgdex-list-expansions",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgdex.expansions"),
  },
  {
    value: "tcgplayer-list-product-lines",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.product.lines"),
  },
  {
    value: "tcgplayer-list-set-names",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.set.names"),
  },
  {
    value: "tcgplayer-list-products",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.products"),
  },
  {
    value: "tcgplayer-list-skus",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.skus"),
  },
  {
    value: "scrydex-list-sets",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.scrydex.sets"),
  },
] satisfies SelectItem[];
const OPTION_QUERY_SCOPE_OPTIONS = [
  { value: "__none__", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.none") },
  ...CATALOG_PROVIDER_SCOPE_OPTIONS.map((scope) => ({ value: scope, label: scope })),
] satisfies SelectItem[];
const OPTION_QUERY_DESCRIPTION_KIND_OPTIONS = [
  { value: "__none__", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.none") },
  { value: "path", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.path") },
  {
    value: "tcgdex-expansion-card-count",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgdex.expansion.card.count"),
  },
  {
    value: "tcgplayer-set-name",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.set.name"),
  },
] satisfies SelectItem[];
const CONNECTOR_KIND_OPTIONS = [
  { value: "tcgdex-json", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgdex.json") },
  {
    value: "tcgplayer-automation-client",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.automation.client"),
  },
  {
    value: "scrydex-scryfall-json",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.scrydex.scryfall.json"),
  },
] satisfies SelectItem[];
const NORMALIZED_OUTPUT_KIND_OPTIONS = [
  { value: "pokemon-card", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.pokemon.card") },
  {
    value: "provider-product",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.product"),
  },
] satisfies SelectItem[];
const EXTERNAL_REFERENCE_TARGET_OPTIONS = [
  {
    value: "catalog-item-reference",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.catalog.item.reference"),
  },
  {
    value: "product-reference",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.product.reference"),
  },
] satisfies SelectItem[];
const EXTERNAL_REFERENCE_AMBIGUITY_OPTIONS = [
  {
    value: "skip-reference",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.skip.reference"),
  },
  { value: "diagnostic", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostic") },
  {
    value: "review-evidence",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.review.evidence"),
  },
] satisfies SelectItem[];
const SELECTED_OPTION_UNKNOWN_POLICY_OPTIONS = [
  {
    value: "leave-unmapped-review-evidence",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.leave.unmapped.as.review.evidence"),
  },
  { value: "diagnostic", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostic") },
] satisfies SelectItem[];
const SELECTED_OPTION_PROVIDER_VALUE_SOURCE_OPTIONS = [
  { value: "record", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.record") },
  { value: "payload", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.payload") },
] satisfies SelectItem[];
const DUPLICATE_PREVENTION_RULE_KIND_OPTIONS = [
  {
    value: "exact-external-catalog-item-reference",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.exact.external.catalog.item.reference"),
  },
  {
    value: "source-observation-link",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.source.observation.link"),
  },
  {
    value: "deterministic-field-match",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.deterministic.field.match"),
  },
  {
    value: "sealed-product-match",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.sealed.product.match"),
  },
  {
    value: "barcode-gtin-match",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.barcode.gtin.match"),
  },
  {
    value: "future-provider-bridge-match",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.future.provider.bridge.match"),
  },
] satisfies SelectItem[];
const DUPLICATE_PREVENTION_CANDIDATE_POLICY_OPTIONS = [
  { value: "reuse", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.reuse.candidate") },
  { value: "review-only", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.review.only") },
] satisfies SelectItem[];
const DUPLICATE_PREVENTION_AMBIGUOUS_POLICY_OPTIONS = [
  {
    value: "block-promotion",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.block.promotion"),
  },
  { value: "review-only", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.review.only") },
] satisfies SelectItem[];
const DUPLICATE_PREVENTION_REPLAY_POLICY_OPTIONS = [
  {
    value: "same-profile-version",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.same.profile.version"),
  },
  {
    value: "operator-reapply-active-version",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.operator.reapplies.active.version"),
  },
] satisfies SelectItem[];
const PROMOTION_COMMAND_NAME_OPTIONS = [
  {
    value: "CreateCatalogItem",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.create.catalog.item"),
  },
  {
    value: "RefreshCatalogItem",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.refresh.catalog.item"),
  },
  {
    value: "ReviseCatalogItemMetadata",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.revise.catalog.item.metadata"),
  },
  {
    value: "AssignBlueprintToCatalogItem",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.assign.blueprint"),
  },
  {
    value: "AssignCatalogItemToCategory",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.assign.category"),
  },
  {
    value: "SetCatalogItemFieldValue",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.set.field.value"),
  },
  {
    value: "SetCatalogItemTags",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.set.tags"),
  },
  {
    value: "SetCatalogItemImageUrls",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.set.image.urls"),
  },
  {
    value: "SetCatalogItemProductAssetSets",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.set.product.asset.sets"),
  },
  {
    value: "LinkExternalCatalogItemReference",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.link.external.catalog.item.reference"),
  },
  {
    value: "LinkExternalProductReference",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.link.external.product.reference"),
  },
] satisfies SelectItem[];
const PROMOTION_COMMAND_REQUIRED_INPUTS: Readonly<
  Record<ProfilePromotionCommandForm["commandName"], readonly string[]>
> = {
  CreateCatalogItem: ["title"],
  RefreshCatalogItem: ["title"],
  ReviseCatalogItemMetadata: ["title"],
  AssignBlueprintToCatalogItem: ["blueprintKey"],
  AssignCatalogItemToCategory: ["categoryKey"],
  SetCatalogItemFieldValue: ["fieldKey", "value"],
  SetCatalogItemTags: ["tags"],
  SetCatalogItemImageUrls: ["imageUrls"],
  SetCatalogItemProductAssetSets: ["productAssetSets"],
  LinkExternalCatalogItemReference: ["references"],
  LinkExternalProductReference: ["providerKey", "externalKey"],
};
const REFERENCE_RECORD_ID_KIND_OPTIONS = [
  { value: "static", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.static.record.id") },
  {
    value: "provider",
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.derived.id"),
  },
] satisfies SelectItem[];
const REFERENCE_VALUE_RULE_KIND_OPTIONS = [
  { value: "static", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.static.value") },
  { value: "path", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.payload.path") },
  { value: "template", label: t("catalog.features.sourceObservations.ui.integrationManagementPage.template") },
] satisfies SelectItem[];

type ProfileBasicsForm = Readonly<{
  displayName: string;
  lifecycle: "draft" | "test";
  status: "active" | "planned";
  compatibilityMode: "executable-mapping-contract" | "transitional-static-profile";
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptionsText: string;
  sourceContract: ProfileSourceContractForm;
  retirementPlan: ProfileRetirementPlanForm;
  optionQueries: readonly ProfileOptionQueryForm[];
  connector: ProfileConnectorForm;
  fixtures: ProfileFixturesForm;
  normalizedObservation: ProfileNormalizedObservationForm;
  externalReferences: ProfileExternalReferencesForm;
  referenceHierarchy: ProfileReferenceHierarchyForm;
  duplicatePrevention: ProfileDuplicatePreventionForm;
  promotionPlan: ProfilePromotionPlanForm;
}>;

type DryRunSafeOverrides = Readonly<{
  name: string;
  language: string;
  sourceUpdatedAt: string;
  sampleFields: Readonly<Record<string, string>>;
}>;

type MigrationEvidenceForm = Readonly<{
  mappingFingerprintBefore: string;
  mappingFingerprintAfter: string;
  fixtureRunId: string;
  replayScope: string;
  observedImpact: string;
  operatorNote: string;
}>;

type ProfileSourceContractForm = Readonly<{
  owner: string;
  repository: string;
  commit: string;
  documentPath: string;
  fixtureSetVersion: string;
}>;

type ProfileRetirementPlanForm = Readonly<{
  enabled: boolean;
  trackingIssueText: string;
  diagnosticText: string;
}>;

type ProfileOptionQueryForm = Readonly<{
  id: string;
  queryKind: string;
  aliasesText: string;
  displayName: string;
  scope: string;
  parentScope: string;
  parentRequired: boolean;
  parentValueKind: string;
  parentDiagnosticText: string;
  operation: string;
  valuePath: string;
  labelPath: string;
  descriptionKind: string;
  descriptionPath: string;
  parentValuePath: string;
  imageUrlPath: string;
  imageUrlCoalescePathsText: string;
  metadataPathsText: string;
}>;

type ProfileConnectorForm = Readonly<{
  kind: string;
  tcgdexBaseUrl: string;
  tcgdexHighQualityAssetVariant: string;
  tcgdexSeriesListEndpoint: string;
  tcgdexSeriesDetailEndpoint: string;
  tcgdexExpansionListEndpoint: string;
  tcgdexExpansionDetailEndpoint: string;
  tcgdexProductDetailEndpoint: string;
  tcgplayerRepositoryOwner: string;
  tcgplayerRepositoryName: string;
  tcgplayerRepositoryCommit: string;
  tcgplayerSourceContractDocument: string;
  tcgplayerCookieName: string;
  tcgplayerSearchDomain: string;
  tcgplayerMarketplaceApiDomain: string;
  tcgplayerInfiniteApiDomain: string;
  tcgplayerMarketplaceGatewayDomain: string;
  tcgplayerRetryStatusCodesText: string;
  scrydexSourceContractDocument: string;
  scrydexAcceptedEvidenceText: string;
  scrydexExcludedEvidenceText: string;
}>;

type ProfileFixturesForm = Readonly<{
  fixtureRoot: string;
  coveredFlows: readonly string[];
}>;

type ProfileNormalizedObservationForm = Readonly<{
  outputKind: "pokemon-card" | "provider-product";
  profileMapping: Record<string, unknown>;
  languageCode: MappingExpressionValue;
  fields: readonly ProfileExpressionFieldForm[];
  hashMaterial: readonly ProfileExpressionListItemForm[];
  mergeIdentity: readonly ProfileExpressionListItemForm[];
}>;

type ProfileExpressionFieldForm = Readonly<{
  id: string;
  fieldKey: string;
  expression: MappingExpressionValue;
}>;

type ProfileExpressionListItemForm = Readonly<{
  id: string;
  expression: MappingExpressionValue;
}>;

type ProfileExternalReferencesForm = Readonly<{
  extractionRules: Record<string, unknown>;
  contracts: readonly ProfileExternalReferenceForm[];
  selectedOptionMapping: ProfileSelectedOptionMappingForm | null;
}>;

type ProfileExternalReferenceForm = Readonly<{
  id: string;
  target: "catalog-item-reference" | "product-reference";
  providerKey: string;
  externalKeyPrefix: string;
  source: MappingExpressionValue;
  ambiguityPolicy: "skip-reference" | "diagnostic" | "review-evidence";
  selectedOptions: ProfileExternalSelectedOptionsForm | null;
}>;

type ProfileExternalSelectedOptionsForm = Readonly<{
  missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence" | "diagnostic";
  dimensions: readonly ProfileExternalSelectedOptionDimensionForm[];
}>;

type ProfileExternalSelectedOptionDimensionForm = Readonly<{
  id: string;
  dimensionKey: string;
  providerValue: MappingExpressionValue;
  optionLookupTableKey: string;
  required: boolean;
}>;

type ProfileSelectedOptionMappingForm = Readonly<{
  source: string;
  providerKey: string;
  externalKeyPrefix: string;
  requiredSourceKeysText: string;
  missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence";
  dimensions: readonly ProfileSelectedOptionMappingDimensionForm[];
}>;

type ProfileSelectedOptionMappingDimensionForm = Readonly<{
  id: string;
  dimensionKey: string;
  providerValueSource: "payload" | "record";
  providerValuePath: string;
  required: boolean;
  optionAliasesText: string;
  valueMappingsText: string;
}>;

type ProfileReferenceHierarchyForm = Readonly<{
  rawMapping: Record<string, unknown>;
  providerReferenceIdPrefix: string;
  targetRecordRuleKey: string;
  providerAttributes: readonly ProfileReferenceProviderAttributeForm[];
  referenceTypes: readonly ProfileReferenceTypeRuleForm[];
  recordRules: readonly ProfileReferenceRecordRuleForm[];
  contracts: readonly ProfileReferenceHierarchyContractForm[];
}>;

type ProfileReferenceProviderAttributeForm = Readonly<{
  id: string;
  typeKey: string;
  providerAttributeKey: string;
}>;

type ProfileReferenceTypeRuleForm = Readonly<{
  id: string;
  referenceTypeId: string;
  typeKey: string;
  name: string;
  descriptionText: string;
  attributeKeysText: string;
}>;

type ProfileReferenceRecordRuleForm = Readonly<{
  id: string;
  ruleKey: string;
  typeKey: string;
  recordIdKind: "static" | "provider";
  staticReferenceRecordId: string;
  providerRecordTypeKey: string;
  providerValuePathsText: string;
  keyRule: ProfileReferenceValueRuleForm;
  nameRule: ProfileReferenceValueRuleForm;
  descriptionRule: ProfileReferenceValueRuleForm;
  attributes: readonly ProfileReferenceAttributeRuleForm[];
  requiredPathsText: string;
  relationshipsText: string;
}>;

type ProfileReferenceValueRuleForm = Readonly<{
  kind: "static" | "path" | "template";
  staticValue: string;
  path: string;
  template: string;
  templateValuesText: string;
}>;

type ProfileReferenceAttributeRuleForm = Readonly<{
  id: string;
  attributeKey: string;
  valueRule: ProfileReferenceValueRuleForm;
  optional: boolean;
}>;

type ProfileReferenceHierarchyContractForm = Readonly<{
  id: string;
  targetTypeKey: string;
  providerAttributeKey: string;
  referenceRecordKey: MappingExpressionValue;
  parents: readonly ProfileReferenceHierarchyParentForm[];
}>;

type ProfileReferenceHierarchyParentForm = Readonly<{
  id: string;
  targetTypeKey: string;
  providerAttributeKey: string;
  referenceRecordKey: MappingExpressionValue;
}>;

type ReferenceHierarchyPreviewRecord = Readonly<{
  typeKey: string;
  providerAttributeKey: string;
  referenceRecordKey: JsonValue;
  deterministicId: string;
  parentChain: readonly ReferenceHierarchyPreviewParent[];
  diagnostics: readonly string[];
}>;

type ReferenceHierarchyPreviewParent = Readonly<{
  typeKey: string;
  providerAttributeKey: string;
  referenceRecordKey: JsonValue;
  deterministicId: string;
  diagnostics: readonly string[];
}>;

type ProfileDuplicatePreventionForm = Readonly<{
  rawMapping: Record<string, unknown>;
  rawAmbiguityRules: Record<string, unknown>;
  exactExternalCatalogItemReferencesFirst: boolean;
  ambiguousCandidatePolicy: "block-promotion" | "review-only";
  replayPolicy: "same-profile-version" | "operator-reapply-active-version";
  mergeCandidateEvidence: readonly ProfileExpressionListItemForm[];
  identityRules: readonly ProfileDuplicatePreventionRuleForm[];
}>;

type ProfileDuplicatePreventionRuleForm = Readonly<{
  id: string;
  ruleKey: string;
  ruleKind:
    | "exact-external-catalog-item-reference"
    | "source-observation-link"
    | "deterministic-field-match"
    | "sealed-product-match"
    | "barcode-gtin-match"
    | "future-provider-bridge-match";
  candidatePolicy: "reuse" | "review-only";
  evidence: readonly ProfileExpressionListItemForm[];
}>;

type ProfilePromotionPlanForm = Readonly<{
  planKind: "catalog-item-promotion";
  requiresReview: true;
  commands: readonly ProfilePromotionCommandForm[];
}>;

type ProfilePromotionCommandForm = Readonly<{
  id: string;
  unsupportedCommandName: string | null;
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
  inputs: readonly ProfileExpressionFieldForm[];
}>;

export function IntegrationManagementPage({
  data,
  query,
  profileReviews,
  permissions,
}: CatalogListRouteData<SourceObservationIntegrationScope> & {
  profileReviews?: ListResponse<CatalogProviderProfileVersionReview> | null;
  permissions?: { canManageCatalog?: boolean };
}) {
  const listControls = useCatalogListQueryControls(query);
  const revalidator = useRevalidator();
  const { addToast } = useToasts();
  const providerProfiles = useSourceObservationProviderProfiles(profileReviews);
  const profileRows = providerProfiles.data?.items ?? EMPTY_PROFILE_REVIEWS;
  const canManageCatalog = permissions?.canManageCatalog ?? true;
  const [moduleArea, setModuleArea] = useState<CatalogIntegrationModuleArea>("health");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [dryRunProfile, setDryRunProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [dryRunFlow, setDryRunFlow] = useState("normal");
  const [dryRunOverrides, setDryRunOverrides] = useState<DryRunSafeOverrides>(emptyDryRunSafeOverrides());
  const [dryRunResult, setDryRunResult] = useState<CatalogProviderProfileDryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [profileActionKey, setProfileActionKey] = useState<string | null>(null);
  const [cloneProfile, setCloneProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [cloneProfileVersion, setCloneProfileVersion] = useState(nextProfileVersion());
  const [activationProfile, setActivationProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [migrationProfile, setMigrationProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [migrationEvidenceForm, setMigrationEvidenceForm] =
    useState<MigrationEvidenceForm>(emptyMigrationEvidenceForm());
  const [editProfile, setEditProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [editBasicsForm, setEditBasicsForm] = useState<ProfileBasicsForm | null>(null);
  const [editProfileError, setEditProfileError] = useState<string | null>(null);
  const [compareProfile, setCompareProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [deprecateProfile, setDeprecateProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [rollbackProfile, setRollbackProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [retireProfile, setRetireProfile] = useState<CatalogProviderProfileVersionReview | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [languageCode, setLanguageCode] = useState("en");
  const [seriesId, setSeriesId] = useState("");
  const [importProviderKey, setImportProviderKey] = useState(TCGDEX_PROVIDER);
  const [tcgplayerScopeKind, setTcgplayerScopeKind] = useState(TCGPLAYER_PRODUCT_LINE_SCOPE);
  const [tcgplayerProductLineId, setTcgplayerProductLineId] = useState("");
  const [tcgplayerSetName, setTcgplayerSetName] = useState("");
  const [tcgplayerProductId, setTcgplayerProductId] = useState("");
  const [importing, setImporting] = useState(false);
  const [integrationProgress, setIntegrationProgress] = useState<CatalogBulkActionProgress | null>(null);
  const [lastIntegrationJobResult, setLastIntegrationJobResult] = useState<LastIntegrationJobResultSummary | null>(
    null,
  );
  const [showReapply, setShowReapply] = useState(false);
  const [reapplyScope, setReapplyScope] = useState<SourceObservationPromotionScope>({});
  const [reapplyPreview, setReapplyPreview] = useState<SourceObservationReapplyPreview | null>(null);
  const [previewingReapply, setPreviewingReapply] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  const [reapplyProgress, setReapplyProgress] = useState<CatalogBulkActionProgress | null>(null);
  const [showPromoteAll, setShowPromoteAll] = useState(false);
  const [promoteAllScope, setPromoteAllScope] = useState<SourceObservationPromotionScope>({});
  const [promoteAllPreview, setPromoteAllPreview] = useState<SourceObservationPromotionPreview | null>(null);
  const [previewingPromoteAll, setPreviewingPromoteAll] = useState(false);
  const [promoteAllRunning, setPromoteAllRunning] = useState(false);
  const [promoteAllProgress, setPromoteAllProgress] = useState<CatalogBulkActionProgress | null>(null);
  const [lastPromotionResult, setLastPromotionResult] = useState<LastPromotionResultSummary | null>(null);
  const summary = useMemo(() => summarizeScopes(data.items ?? []), [data.items]);
  const activeIntegrationJobs = useActiveSourceObservationIntegrationJobs();
  const controlPlaneReadiness = useCatalogIntegrationControlPlaneReadiness();
  const profileWorkspaceItems = useMemo(() => buildProfileWorkspaceItems(profileRows), [profileRows]);
  const selectedProfile = useMemo(
    () => profileRows.find((profile) => profileActionIdentity(profile) === selectedProfileId) ?? null,
    [profileRows, selectedProfileId],
  );
  const activeJobCount = activeIntegrationJobs.data?.items.length ?? 0;

  useEffect(() => {
    if (profileRows.length === 0) {
      if (selectedProfileId) {
        setSelectedProfileId("");
      }
      return;
    }

    if (selectedProfileId && profileRows.some((profile) => profileActionIdentity(profile) === selectedProfileId)) {
      return;
    }

    const defaultProfile = profileRows.find((profile) => profile.active) ?? profileRows[0];
    setSelectedProfileId(profileActionIdentity(defaultProfile));
  }, [profileRows, selectedProfileId]);

  const dryRunAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    dryRunProfile?.providerKey ?? "",
    dryRunProfile?.profileVersion ?? "",
    Boolean(dryRunProfile),
  );
  const editAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    editProfile?.providerKey ?? "",
    editProfile?.profileVersion ?? "",
    Boolean(editProfile),
  );
  const compareAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    compareProfile?.providerKey ?? "",
    compareProfile?.profileVersion ?? "",
    Boolean(compareProfile),
  );
  const activationAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    activationProfile?.providerKey ?? "",
    activationProfile?.profileVersion ?? "",
    Boolean(activationProfile),
  );
  const migrationAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    migrationProfile?.providerKey ?? "",
    migrationProfile?.profileVersion ?? "",
    Boolean(migrationProfile),
  );
  const selectedProfileAuthoringModel = useSourceObservationProviderProfileAuthoringModel(
    selectedProfile?.providerKey ?? "",
    selectedProfile?.profileVersion ?? "",
    Boolean(selectedProfile && moduleArea !== "health"),
  );
  const profileColumns = useMemo(
    () =>
      buildProfileColumns({
        onDryRun: openDryRunDialog,
        onClone: openCloneDialog,
        onEditProfile: openEditProfileDialog,
        onCompareActive: setCompareProfile,
        onMigrationEvidence: openMigrationEvidenceDialog,
        onActivate: setActivationProfile,
        onDeprecate: setDeprecateProfile,
        onRollback: setRollbackProfile,
        onRetire: setRetireProfile,
        busyKey: profileActionKey,
        canManage: canManageCatalog,
      }),
    [canManageCatalog, profileActionKey],
  );
  const integrationProviders = useSourceObservationIntegrationOptions({
    providerKey: TCGDEX_PROVIDER,
    queryKind: "providers",
  });
  const columns = useMemo(
    () =>
      buildColumns({
        onPromoteAll: (scope) => void handlePreviewPromoteAll(scope),
        onResync: (scope) => void runIntegrationJob("import", scope),
        onReapply: (scope) => void handlePreviewReapply(scope),
        busy: importing || reapplying || promoteAllRunning || previewingPromoteAll || previewingReapply,
        canManage: canManageCatalog,
      }),
    [canManageCatalog, importing, previewingPromoteAll, previewingReapply, promoteAllRunning, reapplying],
  );
  const importLanguages = useSourceObservationIntegrationOptions({
    providerKey: TCGDEX_PROVIDER,
    queryKind: "languages",
  });
  const importSeries = useSourceObservationIntegrationOptions({
    providerKey: TCGDEX_PROVIDER,
    queryKind: "series",
    languageCode,
  });
  const tcgplayerProductLines = useSourceObservationIntegrationOptions({
    providerKey: TCGPLAYER_PROVIDER,
    queryKind: "product-lines",
    enabled: importProviderKey === TCGPLAYER_PROVIDER,
  });
  const tcgplayerSetNames = useSourceObservationIntegrationOptions({
    providerKey: TCGPLAYER_PROVIDER,
    queryKind: "set-names",
    parentValue: tcgplayerProductLineId,
    enabled:
      importProviderKey === TCGPLAYER_PROVIDER &&
      tcgplayerScopeKind === TCGPLAYER_PRODUCT_LINE_SCOPE &&
      positiveIntegerText(tcgplayerProductLineId),
  });
  const filterExpansionLanguage = listControls.language || languageCode || "en";
  const filterExpansions = useSourceObservationIntegrationOptions({
    providerKey: listControls.source || TCGDEX_PROVIDER,
    queryKind: "expansions",
    languageCode: filterExpansionLanguage,
    enabled: !listControls.source || listControls.source === TCGDEX_PROVIDER,
  });
  const languageOptions = useMemo(
    () =>
      (importLanguages.data?.items ?? []).map((item) => ({
        label: formatLanguageCodeLabel(metadataString(item.metadata.languageCode) ?? item.value),
        value: item.value,
      })),
    [importLanguages.data],
  );
  const seriesOptions = useMemo(() => toSelectItems(importSeries.data?.items ?? []), [importSeries.data]);
  const tcgplayerProductLineOptions = useMemo(
    () => toSelectItems(tcgplayerProductLines.data?.items ?? []),
    [tcgplayerProductLines.data],
  );
  const tcgplayerSetNameOptions = useMemo(
    () => toSelectItems(tcgplayerSetNames.data?.items ?? []),
    [tcgplayerSetNames.data],
  );
  const filterExpansionOptions = useMemo(
    () => toSelectItems(filterExpansions.data?.items ?? []),
    [filterExpansions.data],
  );
  const providerOptions = useMemo(
    () =>
      (integrationProviders.data?.items ?? []).map((item) => ({
        label: item.label,
        value: item.value,
      })),
    [integrationProviders.data],
  );
  const importProviderOptions = useMemo(
    () =>
      (providerOptions.length > 0
        ? providerOptions
        : [{ label: t("catalog.features.sourceObservations.ui.integrations.provider.tcgdex"), value: TCGDEX_PROVIDER }]
      ).map((item) => ({
        label: item.label,
        value: item.value,
        icon: item.value === TCGPLAYER_PROVIDER ? "package" : item.value === TCGDEX_PROVIDER ? "cards" : "grid",
      })) satisfies SegmentedControlItem[],
    [providerOptions],
  );

  useEffect(() => {
    if (languageOptions.length > 0 && !languageOptions.some((item) => item.value === languageCode)) {
      setLanguageCode(languageOptions[0].value);
    }
  }, [languageOptions, languageCode]);

  useEffect(() => {
    setSeriesId(ALL_SERIES);
  }, [languageCode]);

  useEffect(() => {
    if (seriesOptions.length === 0) {
      setSeriesId(ALL_SERIES);
      return;
    }

    if (seriesId !== ALL_SERIES && !seriesOptions.some((item) => item.value === seriesId)) {
      setSeriesId(ALL_SERIES);
    }
  }, [seriesOptions, seriesId]);

  useEffect(() => {
    if (
      importProviderKey === TCGPLAYER_PROVIDER &&
      tcgplayerProductLineOptions.length > 0 &&
      !tcgplayerProductLineOptions.some((item) => item.value === tcgplayerProductLineId)
    ) {
      setTcgplayerProductLineId(tcgplayerProductLineOptions[0].value);
    }
  }, [importProviderKey, tcgplayerProductLineId, tcgplayerProductLineOptions]);

  useEffect(() => {
    if (
      tcgplayerSetName &&
      tcgplayerSetNameOptions.length > 0 &&
      !tcgplayerSetNameOptions.some((item) => item.value === tcgplayerSetName)
    ) {
      setTcgplayerSetName("");
    }
  }, [tcgplayerSetName, tcgplayerSetNameOptions]);

  async function handleImport() {
    if (importProviderKey === TCGPLAYER_PROVIDER) {
      await runIntegrationJob("import", tcgplayerImportScope());
      setShowImport(false);
      listControls.setFilters({
        source: TCGPLAYER_PROVIDER,
        language: "en",
        setId: tcgplayerScopeKind === TCGPLAYER_PRODUCT_LINE_SCOPE ? tcgplayerSetName.trim() : "",
      });
      return;
    }

    await runIntegrationJob("import", {
      provider: TCGDEX_PROVIDER,
      language: languageCode,
      seriesId: seriesId === ALL_SERIES ? undefined : seriesId,
    });
    setShowImport(false);
    listControls.setFilters({
      source: TCGDEX_PROVIDER,
      language: languageCode,
      setId: "",
    });
  }

  function openDryRunDialog(profile: CatalogProviderProfileVersionReview) {
    setDryRunProfile(profile);
    setDryRunFlow("normal");
    setDryRunOverrides(emptyDryRunSafeOverrides());
    setDryRunResult(null);
    setDryRunError(null);
  }

  function openCloneDialog(profile: CatalogProviderProfileVersionReview) {
    setCloneProfile(profile);
    setCloneProfileVersion(nextProfileVersion(profile.profileVersion));
  }

  function openMigrationEvidenceDialog(profile: CatalogProviderProfileVersionReview) {
    setMigrationProfile(profile);
    setMigrationEvidenceForm(migrationEvidenceFormFromProfile(profile));
  }

  function openEditProfileDialog(profile: CatalogProviderProfileVersionReview) {
    setEditProfile(profile);
    setEditBasicsForm(profileBasicsForm(profile));
    setEditProfileError(null);
  }

  async function handleCloneProfile() {
    if (!cloneProfile) {
      return;
    }
    const key = profileActionIdentity(cloneProfile);
    setProfileActionKey(key);

    try {
      await cloneSourceObservationProviderProfile(cloneProfile.providerKey, cloneProfile.profileVersion, {
        targetProfileVersion: cloneProfileVersion.trim(),
      });
      addToast("Profile version cloned.", "success");
      setCloneProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Profile clone failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleSaveMigrationEvidence() {
    if (!migrationProfile) {
      return;
    }
    const key = profileActionIdentity(migrationProfile);
    setProfileActionKey(key);

    try {
      const migrationEvidence = migrationEvidenceFromForm(migrationEvidenceForm, migrationAuthoringModel.data);
      await updateSourceObservationProviderProfileSection(
        migrationProfile.providerKey,
        migrationProfile.profileVersion,
        "migration-evidence",
        {
          section: "migration-evidence",
          migrationEvidence: {
            ...migrationEvidence,
            recordedAt: new Date().toISOString(),
          },
        },
      );
      addToast("Migration evidence saved.", "success");
      setMigrationProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Migration evidence save failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleSaveProfileBasics() {
    if (!editProfile || !editBasicsForm) {
      return;
    }
    const key = profileActionIdentity(editProfile);
    setProfileActionKey(key);
    setEditProfileError(null);

    try {
      const command: CatalogProviderProfileBasicsUpdateCommand = {
        section: "basics",
        displayName: editBasicsForm.displayName.trim(),
        lifecycle: editBasicsForm.lifecycle,
        status: editBasicsForm.status,
        compatibilityMode: editBasicsForm.compatibilityMode,
        capabilities: [...editBasicsForm.capabilities],
        supportedScopes: [...editBasicsForm.supportedScopes],
        languageOptions: parseListInput(editBasicsForm.languageOptionsText),
      };
      const sourceContractCommand: CatalogProviderProfileSourceContractUpdateCommand = {
        section: "source-contract",
        sourceContract: {
          owner: editBasicsForm.sourceContract.owner.trim(),
          repository: nullableTrimmedValue(editBasicsForm.sourceContract.repository),
          commit: nullableTrimmedValue(editBasicsForm.sourceContract.commit),
          documentPath: editBasicsForm.sourceContract.documentPath.trim(),
          fixtureSetVersion: editBasicsForm.sourceContract.fixtureSetVersion.trim(),
        },
      };
      const retirementPlanCommand: CatalogProviderProfileRetirementPlanUpdateCommand = {
        section: "retirement-plan",
        retirementPlan: editBasicsForm.retirementPlan.enabled
          ? {
              trackingIssue: Number(editBasicsForm.retirementPlan.trackingIssueText),
              removeAfter: "executable-mapping-contract-activated",
              diagnosticText: editBasicsForm.retirementPlan.diagnosticText.trim(),
            }
          : null,
      };
      const providerOptionsCommand: CatalogProviderProfileProviderOptionsUpdateCommand = {
        section: "provider-options",
        optionQueries: editBasicsForm.optionQueries.map(optionQueryFormToCommand),
      };
      const connectorCommand: CatalogProviderProfileConnectorUpdateCommand = {
        section: "connector",
        connector: connectorFormToCommand(editBasicsForm.connector),
      };
      const fixturesCommand: CatalogProviderProfileFixturesUpdateCommand = {
        section: "fixtures",
        fixtures: {
          fixtureRoot: editBasicsForm.fixtures.fixtureRoot.trim(),
          coveredFlows: [...editBasicsForm.fixtures.coveredFlows],
          liveProviderCallsAllowed: false,
        },
      };
      const normalizedObservationCommand: CatalogProviderProfileNormalizedObservationUpdateCommand = {
        section: "normalized-observation",
        normalizedObservationMapping: normalizedObservationMappingFormToCommand(editBasicsForm.normalizedObservation),
        normalizedObservationContract: normalizedObservationContractFormToCommand(editBasicsForm.normalizedObservation),
      };
      const externalReferencesCommand: CatalogProviderProfileExternalReferencesUpdateCommand = {
        section: "external-references",
        externalReferenceExtractionRules: externalReferenceExtractionRulesFormToCommand(
          editBasicsForm.externalReferences,
        ),
        externalReferenceContracts: externalReferenceContractsFormToCommand(editBasicsForm.externalReferences),
      };
      const selectedOptionsCommand: CatalogProviderProfileSelectedOptionsUpdateCommand = {
        section: "selected-options",
        selectedOptionMapping: selectedOptionMappingFormToCommand(
          editBasicsForm.externalReferences.selectedOptionMapping,
        ),
      };
      const referenceHierarchyCommand: CatalogProviderProfileReferenceHierarchyUpdateCommand = {
        section: "reference-hierarchy",
        referenceHierarchyMapping: referenceHierarchyMappingFormToCommand(editBasicsForm.referenceHierarchy),
        referenceHierarchyContracts: referenceHierarchyContractsFormToCommand(editBasicsForm.referenceHierarchy),
      };
      const duplicatePreventionCommand: CatalogProviderProfileDuplicatePreventionUpdateCommand = {
        section: "duplicate-prevention",
        duplicatePreventionMapping: duplicatePreventionMappingFormToCommand(editBasicsForm.duplicatePrevention),
        ambiguityRules: duplicatePreventionAmbiguityRulesFormToCommand(editBasicsForm.duplicatePrevention),
        duplicatePreventionContract: duplicatePreventionContractFormToCommand(editBasicsForm.duplicatePrevention),
      };
      const promotionPlanCommand: CatalogProviderProfilePromotionPlanUpdateCommand = {
        section: "promotion-plan",
        promotionCommandPlan: promotionPlanFormToCommand(editBasicsForm.promotionPlan),
      };
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "basics",
        command,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "source-contract",
        sourceContractCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "retirement-plan",
        retirementPlanCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "provider-options",
        providerOptionsCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "connector",
        connectorCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "fixtures",
        fixturesCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "normalized-observation",
        normalizedObservationCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "external-references",
        externalReferencesCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "selected-options",
        selectedOptionsCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "reference-hierarchy",
        referenceHierarchyCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "duplicate-prevention",
        duplicatePreventionCommand,
      );
      await updateSourceObservationProviderProfileSection(
        editProfile.providerKey,
        editProfile.profileVersion,
        "promotion-plan",
        promotionPlanCommand,
      );
      addToast("Profile basics saved.", "success");
      setEditProfile(null);
      setEditBasicsForm(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Profile basics save failed.";
      setEditProfileError(message);
      addToast(message, "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleRollbackProfile() {
    if (!rollbackProfile) {
      return;
    }
    const key = profileActionIdentity(rollbackProfile);
    setProfileActionKey(key);

    try {
      await rollbackSourceObservationProviderProfile(rollbackProfile.providerKey, rollbackProfile.profileVersion);
      addToast("Profile version rolled back.", "success");
      setRollbackProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Profile rollback failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleRetireProfile() {
    if (!retireProfile) {
      return;
    }
    const key = profileActionIdentity(retireProfile);
    setProfileActionKey(key);

    try {
      await retireSourceObservationProviderProfile(retireProfile.providerKey, retireProfile.profileVersion);
      addToast("Profile version retired.", "success");
      setRetireProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Profile retirement failed.", "danger");
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleDryRunProfile() {
    if (!dryRunProfile) {
      return;
    }

    setDryRunning(true);
    setDryRunError(null);

    try {
      const payload = applyDryRunSafeOverrides(
        selectedDryRunPayload(dryRunAuthoringModel.data, dryRunFlow),
        dryRunOverrides,
      );
      if (!payload) {
        throw new Error("Select a fixture flow with an available sample payload.");
      }
      const result = await dryRunSourceObservationProviderProfile(
        dryRunProfile.providerKey,
        dryRunProfile.profileVersion,
        payload,
      );
      setDryRunResult(result);
    } catch (error) {
      setDryRunError(
        error instanceof SyntaxError
          ? t("catalog.features.sourceObservations.ui.integrations.profile.review.invalid.json")
          : error instanceof Error
            ? error.message
            : t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run.failed"),
      );
    } finally {
      setDryRunning(false);
    }
  }

  async function handleActivateProfile() {
    if (!activationProfile) {
      return;
    }

    const profile = activationProfile;
    const key = profileActionIdentity(profile);
    setProfileActionKey(key);

    try {
      await activateSourceObservationProviderProfile(profile.providerKey, profile.profileVersion);
      addToast(t("catalog.features.sourceObservations.ui.integrations.profile.review.activated"), "success");
      setActivationProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.profile.review.activate.failed"),
        "danger",
      );
    } finally {
      setProfileActionKey(null);
    }
  }

  async function handleDeprecateProfile() {
    if (!deprecateProfile) {
      return;
    }

    const profile = deprecateProfile;
    const key = profileActionIdentity(profile);
    setProfileActionKey(key);

    try {
      await deprecateSourceObservationProviderProfile(profile.providerKey, profile.profileVersion);
      addToast(t("catalog.features.sourceObservations.ui.integrations.profile.review.deprecated"), "success");
      setDeprecateProfile(null);
      providerProfiles.refresh();
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.profile.review.deprecate.failed"),
        "danger",
      );
    } finally {
      setProfileActionKey(null);
    }
  }

  function tcgplayerImportScope(): SourceObservationIntegrationJobScope {
    if (tcgplayerScopeKind === TCGPLAYER_PRODUCT_SCOPE) {
      return {
        provider: TCGPLAYER_PROVIDER,
        language: "en",
        productId: tcgplayerProductId.trim(),
      };
    }

    return {
      provider: TCGPLAYER_PROVIDER,
      language: "en",
      productLineId: tcgplayerProductLineId.trim(),
      setName: tcgplayerSetName.trim() || undefined,
    };
  }

  function canImportCurrentScope(): boolean {
    if (importProviderKey === TCGPLAYER_PROVIDER) {
      return tcgplayerScopeKind === TCGPLAYER_PRODUCT_SCOPE
        ? positiveIntegerText(tcgplayerProductId)
        : positiveIntegerText(tcgplayerProductLineId);
    }

    return Boolean(languageCode);
  }

  function currentReapplyScope(): SourceObservationPromotionScope {
    return {
      search: listControls.search,
      provider: listControls.source,
      language: listControls.language,
      setId: listControls.setId,
    };
  }

  async function handlePreviewReapply(scope = currentReapplyScope()) {
    setPreviewingReapply(true);

    try {
      const preview = await previewReapplySourceObservations(scope);
      setReapplyScope(scope);
      setReapplyPreview(preview);
      setShowReapply(true);
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.reapply.failed"),
        "danger",
      );
    } finally {
      setPreviewingReapply(false);
    }
  }

  async function handleReapplyMatching() {
    setReapplying(true);
    setReapplyProgress(null);

    try {
      const result = await runIntegrationJob("reapply", {
        provider: reapplyScope.provider,
        language: reapplyScope.language,
        setId: reapplyScope.setId,
      });
      setShowReapply(false);
      setReapplyPreview(null);
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error
          ? error.message
          : t("catalog.features.sourceObservations.ui.integrations.reapply.failed"),
        "danger",
      );
    } finally {
      setReapplying(false);
      setReapplyProgress(null);
    }
  }

  async function handlePreviewPromoteAll(scope: SourceObservationPromotionScope) {
    setPreviewingPromoteAll(true);

    try {
      const preview = await previewBulkPromoteSourceObservations(scope);
      setPromoteAllScope(scope);
      setPromoteAllPreview(preview);
      setShowPromoteAll(true);
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setPreviewingPromoteAll(false);
    }
  }

  async function handlePromoteAllMatching() {
    setPromoteAllRunning(true);
    setPromoteAllProgress(null);

    try {
      const result = await bulkPromoteSourceObservationsByScope(promoteAllScope, {
        onProgress: setPromoteAllProgress,
      });
      addToast(
        t("catalog.features.sourceObservations.ui.list.bulk.promote.completed", {
          promoted: String(result.promoted),
          skipped: String(result.skipped),
          failed: String(result.failed),
        }),
        result.failed > 0 ? "warning" : "success",
      );
      setLastPromotionResult({ scope: promoteAllScope, result });
      setShowPromoteAll(false);
      setPromoteAllPreview(null);
      revalidator.revalidate();
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.list.bulk.promote.failed"),
        "danger",
      );
    } finally {
      setPromoteAllRunning(false);
      setPromoteAllProgress(null);
    }
  }

  async function runIntegrationJob(
    action: "import" | "reapply",
    scope: SourceObservationIntegrationJobScope,
  ): Promise<SourceObservationIntegrationJobResult> {
    setImporting(action === "import");
    setIntegrationProgress(queuedProgress());

    try {
      const job = await enqueueSourceObservationIntegrationJob(action, scope);
      const result = await watchSourceObservationIntegrationJob(job.jobId, {
        onProgress: (progress) => {
          setIntegrationProgress((current) =>
            shouldAcceptSourceObservationJobProgress(current, progress) ? progress : current,
          );
          if (action === "reapply") {
            setReapplyProgress((current) =>
              shouldAcceptSourceObservationJobProgress(current, progress) ? progress : current,
            );
          }
        },
      });
      addIntegrationJobCompletionToast(action, result, addToast);
      setLastIntegrationJobResult({ action, scope, result });
      revalidator.revalidate();
      activeIntegrationJobs.refresh();
      return result;
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : t("catalog.features.sourceObservations.ui.integrations.job.failed"),
        "danger",
      );
      throw error;
    } finally {
      setImporting(false);
      setIntegrationProgress(null);
    }
  }

  return (
    <Page>
      <PageHeader title={t("catalog.features.sourceObservations.ui.integrations.title")} />
      <CatalogIntegrationModuleShell
        area={moduleArea}
        onAreaChange={(value) => setModuleArea(value as CatalogIntegrationModuleArea)}
        selectedProfile={selectedProfile}
        summary={summary}
        activeJobCount={activeJobCount}
        canManageCatalog={canManageCatalog}
      >
        <CatalogIntegrationProfileHealthPanel
          profiles={profileRows}
          columns={profileColumns}
          profileWorkspaceItems={profileWorkspaceItems}
          selectedProfileId={selectedProfileId || profileWorkspaceItems[0]?.value || NO_PROFILE_WORKSPACE}
          emptyProfileWorkspaceValue={NO_PROFILE_WORKSPACE}
          onSelectedProfileChange={(value) => setSelectedProfileId(value === NO_PROFILE_WORKSPACE ? "" : value)}
          onRefresh={providerProfiles.refresh}
          getProfileRowId={profileActionIdentity}
          controlPlaneReadiness={controlPlaneReadiness.data ?? null}
          controlPlaneLoading={controlPlaneReadiness.loading}
          controlPlaneError={controlPlaneReadiness.error}
          onRefreshControlPlane={controlPlaneReadiness.refresh}
        />

        <CatalogIntegrationAreaWorkbench
          area={moduleArea}
          selectedProfile={selectedProfile}
          authoringModel={selectedProfileAuthoringModel.data ?? null}
          loading={selectedProfileAuthoringModel.loading}
          error={selectedProfileAuthoringModel.error}
          canManageCatalog={canManageCatalog}
          onEditProfile={openEditProfileDialog}
          onDryRun={openDryRunDialog}
          onCompare={setCompareProfile}
          onMigrationEvidence={openMigrationEvidenceDialog}
          onActivate={setActivationProfile}
          onImport={() => setShowImport(true)}
          onReapply={() => void handlePreviewReapply()}
        />

        <ActionBar>
          <Button leadingIcon="plus" onClick={() => setShowImport(true)} disabled={!canManageCatalog}>
            {t("catalog.features.sourceObservations.ui.integrations.pull.provider.data")}
          </Button>
          <Button
            tone="secondary"
            leadingIcon="badgeCheck"
            loading={previewingReapply}
            disabled={!canManageCatalog || previewingReapply || reapplying || summary.promoted === 0}
            onClick={() => void handlePreviewReapply()}
          >
            {t("catalog.features.sourceObservations.ui.integrations.reapply.promoted")}
          </Button>
        </ActionBar>
        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.scopes")}
            value={formatCount(summary.scopes)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.observations")}
            value={formatCount(summary.total)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.needs.review")}
            value={formatCount(summary.observed + summary.changed)}
          />
          <Stat
            label={t("catalog.features.sourceObservations.ui.integrations.promoted")}
            value={formatCount(summary.promoted)}
          />
        </StatGrid>

        <ActiveIntegrationJobsPanel
          jobs={activeIntegrationJobs.data?.items ?? []}
          loading={activeIntegrationJobs.loading}
          error={activeIntegrationJobs.error}
          onRefresh={activeIntegrationJobs.refresh}
        />

        {lastIntegrationJobResult ? <IntegrationJobResultSummary summary={lastIntegrationJobResult} /> : null}
        {lastPromotionResult ? <PromotionResultSummary summary={lastPromotionResult} /> : null}

        <FilterBar sticky={false}>
          <Select
            label={t("catalog.features.sourceObservations.ui.integrations.provider")}
            value={listControls.source || ALL_PROVIDERS}
            onValueChange={(value) =>
              listControls.setFilters({
                source: value === ALL_PROVIDERS ? "" : value,
                setId: "",
              })
            }
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.providers"),
                value: ALL_PROVIDERS,
              },
              ...providerOptions,
            ]}
            error={integrationProviders.error ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.list.language")}
            value={listControls.language || ALL_LANGUAGES}
            onValueChange={(value) =>
              listControls.setFilters({
                language: value === ALL_LANGUAGES ? "" : value,
                setId: "",
              })
            }
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.list.all.languages"),
                value: ALL_LANGUAGES,
              },
              ...languageOptions,
            ]}
          />
          <Combobox
            label={t("catalog.features.sourceObservations.ui.list.expansion")}
            value={listControls.setId || ALL_EXPANSIONS}
            onValueChange={(value) => listControls.setSetId(value === ALL_EXPANSIONS ? "" : value)}
            placeholder={t("catalog.features.sourceObservations.ui.integrations.all.expansions")}
            noMatchesLabel={t("catalog.features.sourceObservations.ui.integrations.no.expansions.found")}
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.expansions"),
                value: ALL_EXPANSIONS,
              },
              ...withSelectedFallback(filterExpansionOptions, listControls.setId),
            ]}
            disabled={(!!listControls.source && listControls.source !== TCGDEX_PROVIDER) || filterExpansions.loading}
            error={filterExpansions.error ?? undefined}
          />
        </FilterBar>

        <DataTable
          rows={data.items ?? []}
          columns={columns}
          getRowId={(row) => [row.provider_key, row.language_code, row.expansion_id, row.series_id].join(":")}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrations.none.found")}
        />
      </CatalogIntegrationModuleShell>

      <Dialog
        open={Boolean(dryRunProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setDryRunProfile(null);
            setDryRunOverrides(emptyDryRunSafeOverrides());
            setDryRunResult(null);
            setDryRunError(null);
          }
        }}
        title={
          dryRunProfile
            ? t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run.title.named", {
                provider: dryRunProfile.displayName,
                version: dryRunProfile.profileVersion,
              })
            : t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run.title")
        }
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setDryRunProfile(null)} disabled={dryRunning}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button leadingIcon="play" onClick={handleDryRunProfile} loading={dryRunning}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          {dryRunAuthoringModel.loading ? (
            <p>{t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.fixture.templates")}</p>
          ) : null}
          {dryRunAuthoringModel.error ? <p>{dryRunAuthoringModel.error}</p> : null}
          {dryRunAuthoringModel.data ? (
            <Stack gap={3}>
              <Select
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flow")}
                value={dryRunFlow}
                onValueChange={(flow) => {
                  setDryRunFlow(flow);
                  setDryRunOverrides(emptyDryRunSafeOverrides());
                  setDryRunResult(null);
                }}
                items={dryRunFixtureItems(dryRunAuthoringModel.data)}
              />
              <DryRunFixtureSummary model={dryRunAuthoringModel.data} flow={dryRunFlow} />
              <DryRunSafeOverrideEditor
                model={dryRunAuthoringModel.data}
                flow={dryRunFlow}
                overrides={dryRunOverrides}
                onChange={(overrides) => {
                  setDryRunOverrides(overrides);
                  setDryRunResult(null);
                }}
              />
            </Stack>
          ) : null}
          {dryRunError ? <p>{dryRunError}</p> : null}
          {dryRunResult ? <ProfileDryRunResultPanels result={dryRunResult} flow={dryRunFlow} /> : null}
        </Stack>
      </Dialog>

      <Dialog
        open={Boolean(cloneProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setCloneProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.clone.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setCloneProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="plus"
              onClick={handleCloneProfile}
              disabled={!cloneProfileVersion.trim()}
              loading={Boolean(cloneProfile && profileActionKey === profileActionIdentity(cloneProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.clone")}
            </Button>
          </Inline>
        }
      >
        {cloneProfile ? (
          <Stack gap={4}>
            <KeyValueList
              items={[
                { key: "Provider", value: cloneProfile.displayName },
                {
                  key: t("catalog.features.sourceObservations.ui.integrations.profile.review.source.version"),
                  value: cloneProfile.profileVersion,
                },
              ]}
            />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrations.profile.review.target.profile.version")}
              value={cloneProfileVersion}
              onChange={(event) => setCloneProfileVersion(event.currentTarget.value)}
            />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(migrationProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setMigrationProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.migration.evidence.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setMigrationProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handleSaveMigrationEvidence}
              disabled={!canManageCatalog || !migrationEvidenceReady(migrationEvidenceForm)}
              loading={Boolean(migrationProfile && profileActionKey === profileActionIdentity(migrationProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.save.evidence")}
            </Button>
          </Inline>
        }
      >
        {migrationProfile ? (
          <Stack gap={4}>
            <KeyValueList
              items={[
                { key: "Provider", value: migrationProfile.displayName },
                { key: "Version", value: migrationProfile.profileVersion },
                { key: "Current evidence", value: migrationProfile.migrationEvidence?.evidenceText ?? "None" },
                {
                  key: "Recorded at",
                  value: migrationProfile.migrationEvidence?.recordedAt ?? "Not recorded",
                },
                {
                  key: "Recorded by",
                  value: migrationProfile.migrationEvidence?.recordedByUserId ?? "Not recorded",
                },
              ]}
            />
            {migrationAuthoringModel.loading ? (
              <p>
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.activation.readiness")}
              </p>
            ) : null}
            {migrationAuthoringModel.data ? <MigrationReadinessSummary model={migrationAuthoringModel.data} /> : null}
            <MigrationEvidenceEditor
              form={migrationEvidenceForm}
              authoringModel={migrationAuthoringModel.data ?? null}
              onChange={setMigrationEvidenceForm}
            />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(activationProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setActivationProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.activate.profile")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setActivationProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handleActivateProfile}
              disabled={activationConfirmationBlocked(activationAuthoringModel.data, activationAuthoringModel.loading)}
              loading={Boolean(activationProfile && profileActionKey === profileActionIdentity(activationProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.confirm.activation")}
            </Button>
          </Inline>
        }
      >
        {activationProfile ? (
          <Stack gap={4}>
            <KeyValueList
              items={[
                { key: "Provider", value: activationProfile.displayName },
                { key: "Version", value: activationProfile.profileVersion },
                { key: "Lifecycle", value: activationProfile.lifecycle },
                { key: "Validation", value: activationProfile.validation.status },
                { key: "Reference count", value: String(activationProfile.referenceCount) },
              ]}
            />
            {activationAuthoringModel.loading ? (
              <p>
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.activation.readiness")}
              </p>
            ) : null}
            {activationAuthoringModel.error ? <p>{activationAuthoringModel.error}</p> : null}
            {activationAuthoringModel.data ? (
              <ActivationConfirmationReadiness model={activationAuthoringModel.data} />
            ) : null}
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(editProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setEditProfile(null);
            setEditBasicsForm(null);
            setEditProfileError(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.edit.profile.basics")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setEditProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="settings"
              onClick={handleSaveProfileBasics}
              disabled={profileBasicsSaveDisabled(editProfile, editBasicsForm, editAuthoringModel.data)}
              loading={Boolean(editProfile && profileActionKey === profileActionIdentity(editProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.save.basics")}
            </Button>
          </Inline>
        }
      >
        {editProfile && editBasicsForm ? (
          <ProfileBasicsEditor
            profile={editProfile}
            form={editBasicsForm}
            onChange={setEditBasicsForm}
            error={editProfileError}
            authoringModel={editAuthoringModel.data ?? null}
            previewPayload={selectedDryRunPayload(
              editAuthoringModel.data,
              editAuthoringModel.data?.dryRunInputTemplate.defaultFlow ?? "normal",
            )}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(compareProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setCompareProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.compare.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setCompareProfile(null)}>
              {t("catalog.features.sourceObservations.ui.list.close")}
            </Button>
          </Inline>
        }
      >
        {compareProfile ? (
          <Stack gap={3}>
            <KeyValueList
              items={profileComparisonItems(
                compareProfile,
                activeProfileFor(compareProfile, providerProfiles.data?.items ?? []),
              )}
            />
            {compareAuthoringModel.loading ? (
              <p>
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.profile.authoring.model")}
              </p>
            ) : null}
            {compareAuthoringModel.error ? <p>{compareAuthoringModel.error}</p> : null}
            {compareAuthoringModel.data ? <ProfileAuthoringCompare model={compareAuthoringModel.data} /> : null}
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(deprecateProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setDeprecateProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.deprecate.profile")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setDeprecateProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              tone="danger"
              leadingIcon="trash"
              onClick={handleDeprecateProfile}
              loading={Boolean(deprecateProfile && profileActionKey === profileActionIdentity(deprecateProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.confirm.deprecation")}
            </Button>
          </Inline>
        }
      >
        {deprecateProfile ? (
          <Stack gap={3}>
            <p className="text-sm text-secondary">
              {t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.deprecation.keeps.this.profile.readable.for.replay.and",
              )}
            </p>
            <KeyValueList items={lifecycleProfileContextItems(deprecateProfile)} />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(rollbackProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setRollbackProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setRollbackProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="refreshCcw"
              onClick={handleRollbackProfile}
              loading={Boolean(rollbackProfile && profileActionKey === profileActionIdentity(rollbackProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback.confirm")}
            </Button>
          </Inline>
        }
      >
        {rollbackProfile ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback.body", {
                provider: rollbackProfile.displayName,
                version: rollbackProfile.profileVersion,
              })}
            </p>
            <p className="text-sm text-secondary">
              {t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.rollback.reactivates.this.previously.validated.profile.version.and",
              )}
            </p>
            <KeyValueList items={lifecycleProfileContextItems(rollbackProfile)} />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(retireProfile)}
        onOpenChange={(open) => {
          if (!open) {
            setRetireProfile(null);
          }
        }}
        title={t("catalog.features.sourceObservations.ui.integrations.profile.review.retire.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setRetireProfile(null)} disabled={Boolean(profileActionKey)}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              tone="danger"
              leadingIcon="trash"
              onClick={handleRetireProfile}
              loading={Boolean(retireProfile && profileActionKey === profileActionIdentity(retireProfile))}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire")}
            </Button>
          </Inline>
        }
      >
        {retireProfile ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire.body", {
                provider: retireProfile.displayName,
                version: retireProfile.profileVersion,
              })}
            </p>
            <KeyValueList
              items={[
                ...lifecycleProfileContextItems(retireProfile),
                {
                  key: "Retirement gate",
                  value:
                    retireProfile.referenceCount > 0
                      ? "Blocked until all Source Observation references are migrated or archived."
                      : "No Source Observation references remain.",
                },
              ]}
            />
          </Stack>
        ) : null}
      </Dialog>

      <Dialog
        open={showImport}
        onOpenChange={setShowImport}
        title={t("catalog.features.sourceObservations.ui.integrations.pull.provider.data")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowImport(false)} disabled={importing}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              onClick={handleImport}
              loading={importing}
              disabled={
                !canManageCatalog ||
                !canImportCurrentScope() ||
                importing ||
                (importProviderKey === TCGDEX_PROVIDER && (importLanguages.loading || importSeries.loading)) ||
                (importProviderKey === TCGPLAYER_PROVIDER &&
                  tcgplayerScopeKind === TCGPLAYER_PRODUCT_LINE_SCOPE &&
                  (tcgplayerProductLines.loading || tcgplayerSetNames.loading))
              }
            >
              {t("catalog.features.sourceObservations.ui.list.import")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          <SegmentedControl
            aria-label={t("catalog.features.sourceObservations.ui.integrations.provider")}
            value={importProviderKey}
            onValueChange={setImportProviderKey}
            items={importProviderOptions}
            fullWidth
          />
          <ImportActiveProfileSnapshot
            profile={activeProviderProfile(providerProfiles.data?.items ?? [], importProviderKey)}
            providerKey={importProviderKey}
          />
          {importProviderKey === TCGPLAYER_PROVIDER ? (
            <TcgplayerImportScopeCard
              scopeKind={tcgplayerScopeKind}
              onScopeKindChange={setTcgplayerScopeKind}
              productId={tcgplayerProductId}
              onProductIdChange={setTcgplayerProductId}
              productLineId={tcgplayerProductLineId}
              onProductLineIdChange={setTcgplayerProductLineId}
              setName={tcgplayerSetName}
              onSetNameChange={setTcgplayerSetName}
              productLineOptions={tcgplayerProductLineOptions}
              setNameOptions={tcgplayerSetNameOptions}
              productLinesLoading={tcgplayerProductLines.loading}
              setNamesLoading={tcgplayerSetNames.loading}
              productLinesError={tcgplayerProductLines.error}
              setNamesError={tcgplayerSetNames.error}
            />
          ) : (
            <TcgdexImportScopeCard
              languageCode={languageCode}
              onLanguageCodeChange={setLanguageCode}
              seriesId={seriesId}
              onSeriesIdChange={setSeriesId}
              languageOptions={languageOptions}
              seriesOptions={seriesOptions}
              languagesLoading={importLanguages.loading}
              seriesLoading={importSeries.loading}
              languagesError={importLanguages.error}
              seriesError={importSeries.error}
            />
          )}
          {integrationProgress ? (
            <ProgressBar
              value={bulkActionProgressPercent(integrationProgress)}
              formatLabel={() => formatBulkActionProgress(integrationProgress)}
            />
          ) : null}
        </Stack>
      </Dialog>
      <Dialog
        open={showReapply}
        onOpenChange={setShowReapply}
        title={t("catalog.features.sourceObservations.ui.integrations.reapply.confirm.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowReapply(false)} disabled={reapplying}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handleReapplyMatching}
              disabled={reapplying || !reapplyPreview || reapplyPreview.eligible === 0}
              loading={reapplying}
            >
              {t("catalog.features.sourceObservations.ui.integrations.reapply.confirm")}
            </Button>
          </Inline>
        }
      >
        {reapplyPreview ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.reapply.confirm.body", {
                eligible: String(reapplyPreview.eligible),
                ineligible: String(reapplyPreview.ineligible),
                matched: String(reapplyPreview.matched),
              })}
            </p>
            <p>
              {t("catalog.features.sourceObservations.ui.integrations.reapply.confirm.scope", {
                scope: formatReapplyScope(reapplyPreview.scope),
              })}
            </p>
            {reapplyProgress ? (
              <ProgressBar
                value={bulkActionProgressPercent(reapplyProgress)}
                formatLabel={() => formatBulkActionProgress(reapplyProgress)}
              />
            ) : null}
          </Stack>
        ) : null}
      </Dialog>
      <Dialog
        open={showPromoteAll}
        onOpenChange={setShowPromoteAll}
        title={t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.title")}
        footer={
          <Inline gap={2} align="end">
            <Button tone="secondary" onClick={() => setShowPromoteAll(false)} disabled={promoteAllRunning}>
              {t("catalog.features.sourceObservations.ui.list.cancel")}
            </Button>
            <Button
              leadingIcon="badgeCheck"
              onClick={handlePromoteAllMatching}
              disabled={promoteAllRunning || !promoteAllPreview || promoteAllPreview.eligible === 0}
              loading={promoteAllRunning}
            >
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm")}
            </Button>
          </Inline>
        }
      >
        {promoteAllPreview ? (
          <Stack gap={3}>
            <p>
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.body", {
                eligible: String(promoteAllPreview.eligible),
                terminal: String(promoteAllPreview.terminal),
                matched: String(promoteAllPreview.matched),
              })}
            </p>
            <p>
              {t("catalog.features.sourceObservations.ui.list.bulk.promote.all.confirm.scope", {
                scope: formatReapplyScope(promoteAllPreview.scope),
              })}
            </p>
            {promoteAllProgress ? (
              <ProgressBar
                value={bulkActionProgressPercent(promoteAllProgress)}
                formatLabel={() => formatBulkActionProgress(promoteAllProgress)}
              />
            ) : null}
          </Stack>
        ) : null}
      </Dialog>
    </Page>
  );
}

function buildProfileWorkspaceItems(profiles: readonly CatalogProviderProfileVersionReview[]): SelectItem[] {
  return profiles.map((profile) => ({
    value: profileActionIdentity(profile),
    label: t("catalog.features.sourceObservations.ui.integrationManagementPage.value.value.value", {
      value0: String(profile.displayName),
      value1: String(profile.profileVersion),
      value2: String(profile.active ? " active" : ` ${profile.lifecycle}`),
    }),
  }));
}

function lifecycleProfileContextItems(profile: CatalogProviderProfileVersionReview) {
  return [
    { key: "Provider", value: profile.displayName },
    { key: "Version", value: profile.profileVersion },
    { key: "Lifecycle", value: profile.active ? "active" : profile.lifecycle },
    { key: "Validation", value: profile.validation.status },
    { key: "Mapping", value: profile.mappingOutputKind },
    {
      key: t("catalog.features.sourceObservations.ui.integrations.profile.review.source.observation.references"),
      value: String(profile.referenceCount),
    },
  ];
}

type IntegrationRowActions = Readonly<{
  onPromoteAll: (scope: SourceObservationPromotionScope) => void;
  onResync: (scope: SourceObservationIntegrationJobScope) => void;
  onReapply: (scope: SourceObservationPromotionScope) => void;
  busy: boolean;
  canManage: boolean;
}>;

type ProfileRowActions = Readonly<{
  onDryRun: (profile: CatalogProviderProfileVersionReview) => void;
  onClone: (profile: CatalogProviderProfileVersionReview) => void;
  onEditProfile: (profile: CatalogProviderProfileVersionReview) => void;
  onCompareActive: (profile: CatalogProviderProfileVersionReview) => void;
  onMigrationEvidence: (profile: CatalogProviderProfileVersionReview) => void;
  onActivate: (profile: CatalogProviderProfileVersionReview) => void;
  onDeprecate: (profile: CatalogProviderProfileVersionReview) => void;
  onRollback: (profile: CatalogProviderProfileVersionReview) => void;
  onRetire: (profile: CatalogProviderProfileVersionReview) => void;
  busyKey: string | null;
  canManage: boolean;
}>;

function buildProfileColumns(actions: ProfileRowActions): DataColumn<CatalogProviderProfileVersionReview>[] {
  return [
    {
      key: "provider",
      header: t("catalog.features.sourceObservations.ui.integrations.provider"),
      cell: (row) => row.displayName,
    },
    {
      key: "version",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.version"),
      cell: (row) => row.profileVersion,
    },
    {
      key: "lifecycle",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.lifecycle"),
      cell: (row) => (
        <Inline gap={2}>
          <StatusPill tone={row.active ? "success" : row.lifecycle === "deprecated" ? "warning" : "neutral"}>
            {row.active
              ? t("catalog.features.sourceObservations.ui.integrations.profile.review.active")
              : row.lifecycle}
          </StatusPill>
          <span>{row.compatibilityMode}</span>
          <span>{row.referenceCount} refs</span>
        </Inline>
      ),
    },
    {
      key: "validation",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.validation"),
      cell: (row) => (
        <Stack gap={1}>
          <StatusPill tone={row.validation.status === "valid" ? "success" : "danger"}>
            {row.validation.status}
          </StatusPill>
          <span>
            {t("catalog.features.sourceObservations.ui.integrations.profile.review.diagnostic.count", {
              count: String(row.validation.diagnostics.length),
            })}
          </span>
        </Stack>
      ),
    },
    {
      key: "fixture",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.fixture"),
      cell: (row) => (
        <Stack gap={1}>
          <span>{row.sourceContract.fixtureSetVersion}</span>
          <span>
            {t("catalog.features.sourceObservations.ui.integrations.profile.review.fixture.flows", {
              count: String(row.fixtures.coveredFlows.length),
            })}
          </span>
        </Stack>
      ),
    },
    {
      key: "mapping",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.mapping"),
      cell: (row) => (
        <Stack gap={1}>
          <span>{row.mappingOutputKind}</span>
          <span>{row.connectorKind}</span>
        </Stack>
      ),
    },
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.integrations.profile.review.scope"),
      cell: (row) => row.supportedScopes.join(", "),
    },
    {
      key: "actions",
      header: "",
      cell: (row) => {
        const busy = actions.busyKey === profileActionIdentity(row);
        return (
          <Inline gap={2} align="end">
            <Button size="sm" tone="secondary" leadingIcon="play" onClick={() => actions.onDryRun(row)}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.dry.run")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="plus"
              disabled={!actions.canManage}
              onClick={() => actions.onClone(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.clone")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="settings"
              disabled={!actions.canManage || (row.lifecycle !== "draft" && row.lifecycle !== "test")}
              onClick={() => actions.onEditProfile(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.edit.profile")}
            </Button>
            <Button size="sm" tone="secondary" leadingIcon="search" onClick={() => actions.onCompareActive(row)}>
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.compare")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!actions.canManage}
              onClick={() => actions.onMigrationEvidence(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.evidence")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="badgeCheck"
              disabled={!actions.canManage || busy || row.active || row.validation.status !== "valid"}
              loading={busy && !row.active}
              onClick={() => actions.onActivate(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.activate")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="trash"
              disabled={!actions.canManage || busy || row.lifecycle === "deprecated"}
              loading={busy && row.lifecycle !== "deprecated"}
              onClick={() => actions.onDeprecate(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.deprecate")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="refreshCcw"
              disabled={!actions.canManage || busy || row.active || row.lifecycle === "retired"}
              onClick={() => actions.onRollback(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.rollback")}
            </Button>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="trash"
              disabled={
                !actions.canManage || busy || row.active || row.lifecycle === "retired" || row.referenceCount > 0
              }
              onClick={() => actions.onRetire(row)}
            >
              {t("catalog.features.sourceObservations.ui.integrations.profile.review.retire")}
            </Button>
          </Inline>
        );
      },
    },
  ];
}

function ProfileAuthoringCompare({ model }: Readonly<{ model: CatalogProviderProfileAuthoringModel }>) {
  const readiness = model.activationReadiness;
  const blockedChecks = readiness.checks.filter((check) => check.status === "blocked");
  const changedDiffs = model.semanticDiff.changes.filter((change) => change.changed);

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Inline gap={2}>
          <StatusPill tone={readiness.status === "ready" ? "success" : "danger"}>
            {readiness.status === "ready" ? "Ready to activate" : "Activation blocked"}
          </StatusPill>
          <StatusPill tone={model.semanticDiff.mappingFingerprint.changed ? "warning" : "success"}>
            {model.semanticDiff.mappingFingerprint.changed ? "Mapping changed" : "Mapping unchanged"}
          </StatusPill>
        </Inline>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            {
              key: "Candidate",
              value: model.semanticDiff.candidateProfileVersion,
            },
            {
              key: "Active",
              value: model.semanticDiff.activeProfileVersion ?? "None",
            },
            {
              key: "Editable sections",
              value: String(model.editableSections.length),
            },
            {
              key: "Fixture templates",
              value: `${model.fixtureCases.filter((fixtureCase) => fixtureCase.samplePayloadAvailable).length}/${model.fixtureCases.length}`,
            },
            {
              key: "Migration evidence",
              value: readiness.requiresMigrationEvidence ? "Required" : "Not required",
            },
            {
              key: "Candidate fingerprint",
              value: model.semanticDiff.mappingFingerprint.candidate ?? "None",
            },
            {
              key: "Active fingerprint",
              value: model.semanticDiff.mappingFingerprint.active ?? "None",
            },
          ]}
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.activation.readiness")}</h3>
        <DataTable
          rows={blockedChecks.length > 0 ? blockedChecks : readiness.checks}
          columns={activationReadinessColumns}
          getRowId={(row, index) => `${row.checkKey}:${row.path}:${index}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.readiness.checks")}
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.semantic.changes")}</h3>
        <DataTable
          rows={changedDiffs.length > 0 ? changedDiffs : model.semanticDiff.changes}
          columns={semanticDiffColumns}
          getRowId={(row) => row.path}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.semantic.changes")}
          density="compact"
        />
      </Stack>
    </Stack>
  );
}

function ActivationConfirmationReadiness({ model }: Readonly<{ model: CatalogProviderProfileAuthoringModel }>) {
  const readiness = model.activationReadiness;
  const blockedChecks = readiness.checks.filter((check) => check.status === "blocked");

  return (
    <Stack gap={3}>
      <Inline gap={2}>
        <StatusPill tone={readiness.status === "ready" ? "success" : "danger"}>
          {readiness.status === "ready" ? "Ready to activate" : "Activation blocked"}
        </StatusPill>
        <StatusPill tone={model.semanticDiff.mappingFingerprint.changed ? "warning" : "success"}>
          {model.semanticDiff.mappingFingerprint.changed ? "Mapping changed" : "Mapping unchanged"}
        </StatusPill>
      </Inline>
      <MigrationReadinessSummary model={model} />
      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness.checks.2")}</h3>
        <DataTable
          rows={blockedChecks.length > 0 ? blockedChecks : readiness.checks}
          columns={activationReadinessColumns}
          getRowId={(row, index) => `${row.checkKey}:${row.path}:${index}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.readiness.checks")}
          density="compact"
        />
      </Stack>
      {readiness.status === "blocked" ? (
        <p className="text-sm text-secondary">
          {t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.resolve.the.blocking.checks.or.record.the.required",
          )}
        </p>
      ) : (
        <p className="text-sm text-secondary">
          {t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.activation.will.make.this.profile.version.the.default",
          )}
        </p>
      )}
    </Stack>
  );
}

function MigrationReadinessSummary({ model }: Readonly<{ model: CatalogProviderProfileAuthoringModel }>) {
  const readiness = model.activationReadiness;
  const blockedChecks = readiness.checks.filter((check) => check.status === "blocked");

  return (
    <Stack gap={2}>
      <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.activation.readiness")}</h3>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          { key: "Status", value: readiness.status === "ready" ? "Ready" : "Blocked" },
          { key: "Migration evidence", value: readiness.requiresMigrationEvidence ? "Required" : "Not required" },
          { key: "Candidate fingerprint", value: model.semanticDiff.mappingFingerprint.candidate ?? "None" },
          { key: "Active fingerprint", value: model.semanticDiff.mappingFingerprint.active ?? "None" },
          { key: "Reference count", value: String(readiness.referenceCount) },
          { key: "Blocking checks", value: String(blockedChecks.length) },
          {
            key: "Fixture readiness",
            value: readinessCheckSummary(readiness, [
              "fixture-live-calls",
              "fixture-covered-flow",
              "fixture-case",
              "fixture-coverage",
            ]),
          },
          { key: "Import eligibility", value: readinessCheckSummary(readiness, ["import-eligibility"]) },
          { key: "Profile validation", value: readinessCheckSummary(readiness, ["profile-validation"], "Valid") },
          { key: "Lifecycle gate", value: readinessCheckSummary(readiness, ["mutable-lifecycle"]) },
          { key: "Mapping contract", value: readinessCheckSummary(readiness, ["executable-mapping-contract"]) },
          { key: "Duplicate prevention", value: duplicatePreventionReadinessSummary(model.review) },
        ]}
      />
    </Stack>
  );
}

function readinessCheckSummary(
  readiness: CatalogProviderProfileAuthoringModel["activationReadiness"],
  checkKeys: readonly string[],
  passedText = "Ready",
): string {
  const checks = readiness.checks.filter((check) => checkKeys.includes(check.checkKey));
  const blockedChecks = checks.filter((check) => check.status === "blocked");
  if (blockedChecks.length > 0) {
    return `Blocked: ${blockedChecks.length}`;
  }

  return checks.length > 0 ? passedText : "Not reported";
}

function duplicatePreventionReadinessSummary(profile: CatalogProviderProfileVersionReview): string {
  const contract = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : null;
  const duplicatePrevention = isRecord(contract?.duplicatePrevention) ? contract.duplicatePrevention : null;
  const ambiguousCandidatePolicy =
    typeof duplicatePrevention?.ambiguousCandidatePolicy === "string"
      ? duplicatePrevention.ambiguousCandidatePolicy
      : "";
  const replayPolicy = typeof duplicatePrevention?.replayPolicy === "string" ? duplicatePrevention.replayPolicy : "";
  if (!ambiguousCandidatePolicy && !replayPolicy) {
    return "Not configured";
  }

  return `${duplicatePreventionPolicyLabel(ambiguousCandidatePolicy)}; replay ${duplicatePreventionPolicyLabel(
    replayPolicy,
  ).toLowerCase()}`;
}

function duplicatePreventionPolicyLabel(policy: string): string {
  switch (policy) {
    case "block-promotion":
      return "Block promotion";
    case "review-only":
      return "Review only";
    case "reuse":
      return "Reuse";
    case "same-profile-version":
      return "Same profile version";
    case "current-active-profile":
      return "Current active profile";
    case "not-evaluated":
      return "Not evaluated";
    default:
      return policy ? readableFieldLabel(policy) : "Not configured";
  }
}

function duplicatePreventionCandidatePreviewLabel(
  preview: CatalogProviderProfileDryRunResult["duplicatePreventionCandidatePreview"],
): string {
  if (!preview) {
    return "Not evaluated";
  }

  const rule = preview.ruleKey ? ` via ${preview.ruleKey}` : "";
  const diagnostic = preview.diagnosticText ? `; ${preview.diagnosticText}` : "";
  return `${duplicatePreventionPolicyLabel(preview.status)}${rule}; ${preview.candidateCount} candidate(s)${diagnostic}`;
}

function MigrationEvidenceEditor({
  form,
  authoringModel,
  onChange,
}: Readonly<{
  form: MigrationEvidenceForm;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  onChange: (form: MigrationEvidenceForm) => void;
}>) {
  const fingerprints = authoringModel?.semanticDiff.mappingFingerprint;
  const effectiveBefore = form.mappingFingerprintBefore || fingerprints?.active || "";
  const effectiveAfter = form.mappingFingerprintAfter || fingerprints?.candidate || "";
  const setForm = (patch: Partial<MigrationEvidenceForm>) => onChange({ ...form, ...patch });

  return (
    <Stack gap={3}>
      <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.migration.evidence.2")}</h3>
      <Inline gap={2}>
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.before.fingerprint")}
          value={effectiveBefore}
          onChange={(event) => setForm({ mappingFingerprintBefore: event.currentTarget.value })}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.after.fingerprint")}
          value={effectiveAfter}
          onChange={(event) => setForm({ mappingFingerprintAfter: event.currentTarget.value })}
        />
      </Inline>
      <Inline gap={2}>
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.run.id")}
          value={form.fixtureRunId}
          onChange={(event) => setForm({ fixtureRunId: event.currentTarget.value })}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.replay.scope")}
          value={form.replayScope}
          onChange={(event) => setForm({ replayScope: event.currentTarget.value })}
        />
      </Inline>
      <Textarea
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.observed.impact")}
        rows={3}
        value={form.observedImpact}
        onChange={(event) => setForm({ observedImpact: event.currentTarget.value })}
      />
      <Textarea
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.operator.note")}
        rows={4}
        value={form.operatorNote}
        onChange={(event) => setForm({ operatorNote: event.currentTarget.value })}
      />
    </Stack>
  );
}

function ImportActiveProfileSnapshot({
  profile,
  providerKey,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview | null;
  providerKey: string;
}>) {
  if (!profile) {
    return (
      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.active.profile.snapshot")}</h3>
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.no.active.profile.is.available.for")}
          {providerKey}.
        </p>
      </Stack>
    );
  }

  return (
    <Stack gap={2}>
      <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.active.profile.snapshot")}</h3>
      <KeyValueList
        density="compact"
        variant="plain"
        items={[
          { key: "Provider key", value: profile.providerKey },
          { key: "Profile key", value: profile.profileKey },
          { key: "Profile version", value: profile.profileVersion },
          { key: "Lifecycle", value: profile.lifecycle },
          { key: "Output kind", value: profile.mappingOutputKind },
          { key: "Capabilities", value: profile.capabilities.join(", ") || "None" },
          { key: "Supported scopes", value: profile.supportedScopes.join(", ") || "None" },
          { key: "Fixture set", value: profile.sourceContract.fixtureSetVersion },
        ]}
      />
    </Stack>
  );
}

function TcgdexImportScopeCard({
  languageCode,
  onLanguageCodeChange,
  seriesId,
  onSeriesIdChange,
  languageOptions,
  seriesOptions,
  languagesLoading,
  seriesLoading,
  languagesError,
  seriesError,
}: Readonly<{
  languageCode: string;
  onLanguageCodeChange: (value: string) => void;
  seriesId: string;
  onSeriesIdChange: (value: string) => void;
  languageOptions: SelectItem[];
  seriesOptions: SelectItem[];
  languagesLoading: boolean;
  seriesLoading: boolean;
  languagesError: string | null;
  seriesError: string | null;
}>) {
  const scope = {
    provider: TCGDEX_PROVIDER,
    language: languageCode,
    seriesId: seriesId === ALL_SERIES ? undefined : seriesId,
  };

  return (
    <Stack gap={3}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgdex.import.scope")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider"),
            value: "TCGdex card catalog",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.language"),
            value: selectedSelectItemLabel(languageOptions, languageCode),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.series"),
            value: seriesId === ALL_SERIES ? "All series" : selectedSelectItemLabel(seriesOptions, seriesId),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.job.scope"),
            value: formatIntegrationJobScope(scope),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness"),
            value: languageCode ? (
              <StatusPill tone="success">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.ready")}
              </StatusPill>
            ) : (
              <StatusPill tone="warning">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.needs.language")}
              </StatusPill>
            ),
          },
        ]}
      />
      <Inline gap={3} align="start">
        <Select
          label={t("catalog.features.sourceObservations.ui.list.language")}
          value={languageCode}
          onValueChange={onLanguageCodeChange}
          items={languageOptions}
          disabled={languagesLoading || languageOptions.length === 0}
          error={languagesError ?? undefined}
        />
        <Select
          label={t("catalog.features.sourceObservations.ui.list.series")}
          value={seriesId}
          onValueChange={onSeriesIdChange}
          items={[
            {
              label: t("catalog.features.sourceObservations.ui.integrations.all.series"),
              value: ALL_SERIES,
            },
            ...seriesOptions,
          ]}
          disabled={seriesLoading}
          error={seriesError ?? undefined}
        />
      </Inline>
      {languagesLoading || seriesLoading ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.tcgdex.scope.options")}
        </p>
      ) : null}
    </Stack>
  );
}

function TcgplayerImportScopeCard({
  scopeKind,
  onScopeKindChange,
  productId,
  onProductIdChange,
  productLineId,
  onProductLineIdChange,
  setName,
  onSetNameChange,
  productLineOptions,
  setNameOptions,
  productLinesLoading,
  setNamesLoading,
  productLinesError,
  setNamesError,
}: Readonly<{
  scopeKind: string;
  onScopeKindChange: (value: string) => void;
  productId: string;
  onProductIdChange: (value: string) => void;
  productLineId: string;
  onProductLineIdChange: (value: string) => void;
  setName: string;
  onSetNameChange: (value: string) => void;
  productLineOptions: SelectItem[];
  setNameOptions: SelectItem[];
  productLinesLoading: boolean;
  setNamesLoading: boolean;
  productLinesError: string | null;
  setNamesError: string | null;
}>) {
  const productScope = scopeKind === TCGPLAYER_PRODUCT_SCOPE;
  const scope = productScope
    ? {
        provider: TCGPLAYER_PROVIDER,
        language: "en",
        productId: productId.trim(),
      }
    : {
        provider: TCGPLAYER_PROVIDER,
        language: "en",
        productLineId: productLineId.trim(),
        setName: setName.trim() || undefined,
      };
  const ready = productScope ? positiveIntegerText(productId) : positiveIntegerText(productLineId);

  return (
    <Stack gap={3}>
      <TaskSummary
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.tcgplayer.import.scope")}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider"),
            value: "TCGplayer marketplace catalog",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.scope.type"),
            value: productScope ? "Product" : "Product line",
          },
          {
            label: productScope ? "Product ID" : "Product line",
            value: productScope
              ? productId.trim() || "Not selected"
              : selectedSelectItemLabel(productLineOptions, productLineId),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.set"),
            value: productScope ? "Single product import" : setName.trim() || "All sets in product line",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.job.scope"),
            value: formatIntegrationJobScope(scope),
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrationManagementPage.readiness"),
            value: ready ? (
              <StatusPill tone="success">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.ready")}
              </StatusPill>
            ) : (
              <StatusPill tone="warning">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.needs.scope")}
              </StatusPill>
            ),
          },
        ]}
      />
      <SegmentedControl
        value={scopeKind}
        onValueChange={onScopeKindChange}
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.integrations.tcgplayer.scope.product.line"),
            value: TCGPLAYER_PRODUCT_LINE_SCOPE,
            icon: "grid",
          },
          {
            label: t("catalog.features.sourceObservations.ui.integrations.tcgplayer.scope.product"),
            value: TCGPLAYER_PRODUCT_SCOPE,
            icon: "package",
          },
        ]}
        fullWidth
      />
      {productScope ? (
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrations.tcgplayer.product.id")}
          value={productId}
          onChange={(event) => onProductIdChange(event.target.value)}
          inputMode="numeric"
        />
      ) : (
        <Inline gap={3} align="start">
          <Select
            label={t("catalog.features.sourceObservations.ui.integrations.tcgplayer.product.line")}
            value={productLineId}
            onValueChange={onProductLineIdChange}
            items={withSelectedFallback(productLineOptions, productLineId)}
            disabled={productLinesLoading || productLineOptions.length === 0}
            error={productLinesError ?? undefined}
          />
          <Select
            label={t("catalog.features.sourceObservations.ui.integrations.tcgplayer.set.name")}
            value={setName || ALL_TCGPLAYER_SETS}
            onValueChange={(value) => onSetNameChange(value === ALL_TCGPLAYER_SETS ? "" : value)}
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.integrations.all.sets"),
                value: ALL_TCGPLAYER_SETS,
              },
              ...withSelectedFallback(setNameOptions, setName),
            ]}
            disabled={!positiveIntegerText(productLineId) || setNamesLoading}
            error={setNamesError ?? undefined}
          />
        </Inline>
      )}
      {productLinesLoading || setNamesLoading ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.tcgplayer.scope.options")}
        </p>
      ) : null}
    </Stack>
  );
}

function ActiveIntegrationJobsPanel({
  jobs,
  loading,
  error,
  onRefresh,
}: Readonly<{
  jobs: readonly CatalogIntegrationJob<SourceObservationIntegrationJobResult>[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}>) {
  if (!loading && !error && jobs.length === 0) {
    return null;
  }

  return (
    <Stack gap={3}>
      <Inline gap={3} align="center">
        <Stack gap={1}>
          <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.active.integration.jobs")}</h3>
          <p className="text-sm text-secondary">
            {t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.queued.and.running.provider.imports.or.reapply.jobs",
            )}
          </p>
        </Stack>
        <Button tone="secondary" leadingIcon="refreshCcw" onClick={onRefresh}>
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.refresh.jobs")}
        </Button>
      </Inline>
      {error ? <p>{error}</p> : null}
      {loading ? (
        <p>{t("catalog.features.sourceObservations.ui.integrationManagementPage.loading.active.jobs")}</p>
      ) : null}
      <DataTable
        rows={[...jobs]}
        columns={activeIntegrationJobColumns}
        getRowId={(row) => row.jobId}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.active.integration.jobs")}
        density="compact"
      />
    </Stack>
  );
}

const activeIntegrationJobColumns: DataColumn<CatalogIntegrationJob<SourceObservationIntegrationJobResult>>[] = [
  {
    key: "job",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.job"),
    cell: (row) => (
      <Stack gap={1}>
        <Inline gap={2}>
          <StatusPill tone={row.status === "failed" ? "danger" : row.status === "completed" ? "success" : "info"}>
            {row.status}
          </StatusPill>
          <span>{row.action}</span>
        </Inline>
        <span className="text-xs text-secondary">{row.jobId}</span>
      </Stack>
    ),
  },
  {
    key: "profile",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.snapshot"),
    cell: (row) =>
      row.profileSnapshot ? (
        <Stack gap={1}>
          <span>
            {row.profileSnapshot.providerKey} {row.profileSnapshot.profileVersion}
          </span>
          <span className="text-xs text-secondary">
            {row.profileSnapshot.profileKey} - {row.profileSnapshot.lifecycle}
          </span>
          <span className="text-xs text-secondary">{row.profileSnapshot.sourceMappingFingerprint}</span>
        </Stack>
      ) : (
        "No snapshot"
      ),
  },
  {
    key: "scope",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.scope"),
    cell: (row) => formatIntegrationJobScope(row.scope),
  },
  {
    key: "progress",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.progress"),
    cell: (row) => (
      <ProgressBar
        value={bulkActionProgressPercent(row.progress)}
        tone={row.status === "failed" ? "danger" : row.status === "completed" ? "success" : "active"}
        formatLabel={() => formatBulkActionProgress(row.progress)}
      />
    ),
  },
];

function IntegrationJobResultSummary({ summary }: Readonly<{ summary: LastIntegrationJobResultSummary }>) {
  const failureGroups = integrationFailureGroups(summary.result);
  const reviewHref = sourceObservationIntegrationJobScopeHref(summary.scope);

  return (
    <Stack gap={3}>
      <Cluster gap={3} align="center" justify="between">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.last.job.result")}</h3>
        <LinkButton href={reviewHref} size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.review.matching.observations")}
        </LinkButton>
      </Cluster>
      <KeyValueList items={[{ key: "Scope", value: formatIntegrationJobScope(summary.scope) }]} />
      <StatGrid columns={{ base: 2, md: 3 }}>
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.requested")}
          value={formatCount(summary.result.requested)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.imported")}
          value={formatCount(summary.result.imported)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.observed")}
          value={formatCount(summary.result.observed)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reapplied")}
          value={formatCount(summary.result.reapplied)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.skipped")}
          value={formatCount(summary.result.skipped)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.failed")}
          value={formatCount(summary.result.failed)}
        />
      </StatGrid>
      <DataTable
        rows={failureGroups}
        columns={integrationFailureGroupColumns}
        getRowId={(row) => row.reason}
        emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.grouped.failures")}
        density="compact"
      />
    </Stack>
  );
}

function PromotionResultSummary({ summary }: Readonly<{ summary: LastPromotionResultSummary }>) {
  const reviewHref = sourceObservationPromotionScopeHref(summary.scope);

  return (
    <Stack gap={3}>
      <Cluster gap={3} align="center" justify="between">
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.last.promotion.result")}</h3>
        <LinkButton href={reviewHref} size="sm" tone="secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.review.matching.observations")}
        </LinkButton>
      </Cluster>
      <KeyValueList items={[{ key: "Scope", value: formatPromotionScope(summary.scope) }]} />
      <StatGrid columns={{ base: 2, md: 5 }}>
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.requested")}
          value={formatCount(summary.result.requested)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.promoted")}
          value={formatCount(summary.result.promoted)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.rejected")}
          value={formatCount(summary.result.rejected ?? 0)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.skipped")}
          value={formatCount(summary.result.skipped)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.failed")}
          value={formatCount(summary.result.failed)}
        />
      </StatGrid>
    </Stack>
  );
}

function ProfileBasicsEditor({
  profile,
  form,
  onChange,
  error,
  authoringModel,
  previewPayload,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview;
  form: ProfileBasicsForm;
  onChange: (form: ProfileBasicsForm) => void;
  error: string | null;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileBasicsForm>) => onChange({ ...form, ...patch });
  const setSourceContract = (patch: Partial<ProfileSourceContractForm>) =>
    setForm({ sourceContract: { ...form.sourceContract, ...patch } });
  const setRetirementPlan = (patch: Partial<ProfileRetirementPlanForm>) =>
    setForm({ retirementPlan: { ...form.retirementPlan, ...patch } });
  const setOptionQueries = (optionQueries: readonly ProfileOptionQueryForm[]) => setForm({ optionQueries });
  const setOptionQuery = (id: string, patch: Partial<ProfileOptionQueryForm>) =>
    setOptionQueries(form.optionQueries.map((query) => (query.id === id ? { ...query, ...patch } : query)));
  const setConnector = (patch: Partial<ProfileConnectorForm>) =>
    setForm({ connector: { ...form.connector, ...patch } });
  const setFixtures = (patch: Partial<ProfileFixturesForm>) => setForm({ fixtures: { ...form.fixtures, ...patch } });
  const setNormalizedObservation = (normalizedObservation: ProfileNormalizedObservationForm) =>
    setForm({ normalizedObservation });
  const setExternalReferences = (externalReferences: ProfileExternalReferencesForm) => setForm({ externalReferences });
  const setReferenceHierarchy = (referenceHierarchy: ProfileReferenceHierarchyForm) => setForm({ referenceHierarchy });
  const setDuplicatePrevention = (duplicatePrevention: ProfileDuplicatePreventionForm) =>
    setForm({ duplicatePrevention });
  const setPromotionPlan = (promotionPlan: ProfilePromotionPlanForm) => setForm({ promotionPlan });
  const editable = profileLifecycleEditable(profile);
  const retirementTrackingIssueInvalid =
    form.retirementPlan.enabled && !positiveIntegerText(form.retirementPlan.trackingIssueText);
  const optionQueryDiagnostics = validateOptionQueryForms(form.optionQueries);
  const connectorDiagnostics = validateConnectorForm(form.connector);
  const normalizedObservationDiagnostics = validateNormalizedObservationForm(form.normalizedObservation);
  const externalReferenceDiagnostics = validateExternalReferencesForm(
    form.externalReferences,
    authoringModel?.selectedOptionSchema ?? null,
  );
  const referenceHierarchyDiagnostics = validateReferenceHierarchyForm(form.referenceHierarchy);
  const duplicatePreventionDiagnostics = validateDuplicatePreventionForm(form.duplicatePrevention);
  const promotionPlanDiagnostics = validatePromotionPlanForm(form.promotionPlan, form);
  const missingFixtureFlows = REQUIRED_FIXTURE_FLOW_OPTIONS.filter(
    (flow) => !form.fixtures.coveredFlows.includes(flow),
  );

  return (
    <Stack gap={4}>
      <KeyValueList
        items={[
          { key: "Provider key", value: profile.providerKey },
          { key: "Profile key", value: profile.profileKey },
          { key: "Profile version", value: profile.profileVersion },
          { key: "Lifecycle", value: profile.lifecycle },
          { key: "Active", value: profile.active ? "Yes" : "No" },
          { key: "Created", value: profile.authoringAudit?.createdAt ?? "Not recorded" },
          { key: "Created by", value: profile.authoringAudit?.createdByUserId ?? "Not recorded" },
          { key: "Created for account", value: profile.authoringAudit?.createdForAccountId ?? "Not recorded" },
          { key: "Last updated", value: profile.authoringAudit?.updatedAt ?? "Not recorded" },
          { key: "Updated by", value: profile.authoringAudit?.updatedByUserId ?? "Not recorded" },
          { key: "Updated for account", value: profile.authoringAudit?.updatedForAccountId ?? "Not recorded" },
          { key: "Migration evidence recorded", value: profile.migrationEvidence?.recordedAt ?? "Not recorded" },
          { key: "Migration evidence by", value: profile.migrationEvidence?.recordedByUserId ?? "Not recorded" },
          {
            key: "Migration evidence account",
            value: profile.migrationEvidence?.recordedForAccountId ?? "Not recorded",
          },
        ]}
      />

      {!editable ? (
        <p className="text-sm text-secondary">
          {t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.this.profile.version.is.immutable.from.the.basics",
          )}
        </p>
      ) : null}

      <TextInput
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.display.name")}
        value={form.displayName}
        disabled={!editable}
        onChange={(event) => setForm({ displayName: event.currentTarget.value })}
      />

      <Inline gap={3}>
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.lifecycle")}
          value={form.lifecycle}
          onValueChange={(value) => setForm({ lifecycle: value === "test" ? "test" : "draft" })}
          items={PROFILE_LIFECYCLE_OPTIONS}
          disabled={!editable}
        />
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.status")}
          value={form.status}
          onValueChange={(value) => setForm({ status: value === "active" ? "active" : "planned" })}
          items={PROFILE_STATUS_OPTIONS}
          disabled={!editable}
        />
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.compatibility")}
          value={form.compatibilityMode}
          onValueChange={(value) =>
            setForm({
              compatibilityMode:
                value === "transitional-static-profile" ? "transitional-static-profile" : "executable-mapping-contract",
            })
          }
          items={PROFILE_COMPATIBILITY_MODE_OPTIONS}
          disabled={!editable}
        />
      </Inline>

      <CheckboxSet
        legend="Capabilities"
        options={CATALOG_PROVIDER_CAPABILITY_OPTIONS}
        selected={form.capabilities}
        onChange={(capabilities) => setForm({ capabilities })}
        disabled={!editable}
      />

      <CheckboxSet
        legend="Supported scopes"
        options={CATALOG_PROVIDER_SCOPE_OPTIONS}
        selected={form.supportedScopes}
        onChange={(supportedScopes) => setForm({ supportedScopes })}
        disabled={!editable}
      />

      <Textarea
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.language.options")}
        description={t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated.language.codes",
        )}
        value={form.languageOptionsText}
        disabled={!editable}
        onChange={(event) => setForm({ languageOptionsText: event.currentTarget.value })}
        rows={4}
      />

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.source.contract")}
        </h3>
        <Inline gap={3}>
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.contract.owner")}
            value={form.sourceContract.owner}
            disabled={!editable}
            required
            onChange={(event) => setSourceContract({ owner: event.currentTarget.value })}
          />
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.repository")}
            value={form.sourceContract.repository}
            disabled={!editable}
            onChange={(event) => setSourceContract({ repository: event.currentTarget.value })}
          />
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.commit")}
            value={form.sourceContract.commit}
            disabled={!editable}
            onChange={(event) => setSourceContract({ commit: event.currentTarget.value })}
          />
        </Inline>
        <Inline gap={3}>
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.document.path")}
            value={form.sourceContract.documentPath}
            disabled={!editable}
            required
            onChange={(event) => setSourceContract({ documentPath: event.currentTarget.value })}
          />
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.set.version")}
            value={form.sourceContract.fixtureSetVersion}
            disabled={!editable}
            required
            onChange={(event) => setSourceContract({ fixtureSetVersion: event.currentTarget.value })}
          />
        </Inline>
      </Stack>

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.retirement.plan")}
        </h3>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={form.retirementPlan.enabled}
            disabled={!editable}
            onChange={() => setRetirementPlan({ enabled: !form.retirementPlan.enabled })}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          <span>{t("catalog.features.sourceObservations.ui.integrationManagementPage.track.planned.retirement")}</span>
        </label>
        {form.retirementPlan.enabled ? (
          <Inline gap={3}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.tracking.issue")}
              value={form.retirementPlan.trackingIssueText}
              disabled={!editable}
              inputMode="numeric"
              error={retirementTrackingIssueInvalid ? "Enter a positive issue number." : undefined}
              onChange={(event) => setRetirementPlan({ trackingIssueText: event.currentTarget.value })}
            />
            <Select
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.remove.after")}
              value="executable-mapping-contract-activated"
              disabled
              items={[
                {
                  value: "executable-mapping-contract-activated",
                  label: t(
                    "catalog.features.sourceObservations.ui.integrationManagementPage.executable.mapping.contract.activated",
                  ),
                },
              ]}
            />
          </Inline>
        ) : null}
        {form.retirementPlan.enabled ? (
          <Textarea
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.retirement.diagnostic")}
            value={form.retirementPlan.diagnosticText}
            disabled={!editable}
            required
            onChange={(event) => setRetirementPlan({ diagnosticText: event.currentTarget.value })}
            rows={3}
          />
        ) : null}
      </Stack>

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.connector")}
        </h3>
        {connectorDiagnostics.length > 0 ? (
          <ul className="text-sm text-danger">
            {connectorDiagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        ) : null}
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.connector.kind")}
          value={form.connector.kind}
          disabled={!editable}
          items={CONNECTOR_KIND_OPTIONS}
          onValueChange={(value) => setConnector({ kind: value })}
        />
        {form.connector.kind === "tcgdex-json" ? (
          <Stack gap={3}>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.base.url")}
                value={form.connector.tcgdexBaseUrl}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexBaseUrl: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.high.quality.asset.variant")}
                value={form.connector.tcgdexHighQualityAssetVariant}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexHighQualityAssetVariant: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.series.list.endpoint")}
                value={form.connector.tcgdexSeriesListEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexSeriesListEndpoint: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.series.detail.endpoint")}
                value={form.connector.tcgdexSeriesDetailEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexSeriesDetailEndpoint: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.expansion.list.endpoint")}
                value={form.connector.tcgdexExpansionListEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexExpansionListEndpoint: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.expansion.detail.endpoint")}
                value={form.connector.tcgdexExpansionDetailEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexExpansionDetailEndpoint: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.product.detail.endpoint")}
                value={form.connector.tcgdexProductDetailEndpoint}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgdexProductDetailEndpoint: event.currentTarget.value })}
              />
            </Inline>
          </Stack>
        ) : null}
        {form.connector.kind === "tcgplayer-automation-client" ? (
          <Stack gap={3}>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.repository.owner")}
                value={form.connector.tcgplayerRepositoryOwner}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerRepositoryOwner: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.repository.name")}
                value={form.connector.tcgplayerRepositoryName}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerRepositoryName: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.repository.commit")}
                value={form.connector.tcgplayerRepositoryCommit}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerRepositoryCommit: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.source.contract.document")}
                value={form.connector.tcgplayerSourceContractDocument}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerSourceContractDocument: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.cookie.name")}
                value={form.connector.tcgplayerCookieName}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerCookieName: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.retry.status.codes")}
                value={form.connector.tcgplayerRetryStatusCodesText}
                disabled={!editable}
                onChange={(event) => setConnector({ tcgplayerRetryStatusCodesText: event.currentTarget.value })}
              />
            </Inline>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.search.domain")}
                value={form.connector.tcgplayerSearchDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerSearchDomain: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.marketplace.api.domain")}
                value={form.connector.tcgplayerMarketplaceApiDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerMarketplaceApiDomain: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.infinite.api.domain")}
                value={form.connector.tcgplayerInfiniteApiDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerInfiniteApiDomain: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.marketplace.gateway.domain")}
                value={form.connector.tcgplayerMarketplaceGatewayDomain}
                disabled={!editable}
                required
                onChange={(event) => setConnector({ tcgplayerMarketplaceGatewayDomain: event.currentTarget.value })}
              />
            </Inline>
          </Stack>
        ) : null}
        {form.connector.kind === "scrydex-scryfall-json" ? (
          <Stack gap={3}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.scrydex.contract.document")}
              value={form.connector.scrydexSourceContractDocument}
              disabled={!editable}
              required
              onChange={(event) => setConnector({ scrydexSourceContractDocument: event.currentTarget.value })}
            />
            <KeyValueList items={[{ key: "Fixture backed only", value: "Yes" }]} />
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.accepted.evidence")}
              description={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated.evidence.keys",
              )}
              value={form.connector.scrydexAcceptedEvidenceText}
              disabled={!editable}
              rows={3}
              onChange={(event) => setConnector({ scrydexAcceptedEvidenceText: event.currentTarget.value })}
            />
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.excluded.evidence")}
              description={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated.evidence.keys",
              )}
              value={form.connector.scrydexExcludedEvidenceText}
              disabled={!editable}
              rows={3}
              onChange={(event) => setConnector({ scrydexExcludedEvidenceText: event.currentTarget.value })}
            />
          </Stack>
        ) : null}
      </Stack>

      <Stack gap={3}>
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.fixtures")}
        </h3>
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.root")}
          value={form.fixtures.fixtureRoot}
          disabled={!editable}
          required
          onChange={(event) => setFixtures({ fixtureRoot: event.currentTarget.value })}
        />
        <KeyValueList items={[{ key: "Live provider calls allowed", value: "No" }]} />
        {missingFixtureFlows.length > 0 ? (
          <p className="text-sm text-danger">
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.missing.required.fixture.flows")}{" "}
            {missingFixtureFlows.join(", ")}
          </p>
        ) : null}
        <CheckboxSet
          legend="Covered fixture flows"
          options={REQUIRED_FIXTURE_FLOW_OPTIONS}
          selected={form.fixtures.coveredFlows}
          disabled={!editable}
          onChange={(coveredFlows) => setFixtures({ coveredFlows })}
        />
      </Stack>

      <NormalizedObservationEditor
        form={form.normalizedObservation}
        onChange={setNormalizedObservation}
        diagnostics={normalizedObservationDiagnostics}
        editable={editable}
        authoringModel={authoringModel}
        previewPayload={previewPayload}
      />

      <ExternalReferencesEditor
        form={form.externalReferences}
        onChange={setExternalReferences}
        diagnostics={externalReferenceDiagnostics}
        editable={editable}
        authoringModel={authoringModel}
        previewPayload={previewPayload}
      />

      <ReferenceHierarchyEditor
        form={form.referenceHierarchy}
        onChange={setReferenceHierarchy}
        diagnostics={referenceHierarchyDiagnostics}
        editable={editable}
        previewPayload={previewPayload}
      />

      <DuplicatePreventionEditor
        form={form.duplicatePrevention}
        onChange={setDuplicatePrevention}
        diagnostics={duplicatePreventionDiagnostics}
        editable={editable}
        previewPayload={previewPayload}
      />

      <PromotionPlanEditor
        profile={profile}
        form={form.promotionPlan}
        onChange={setPromotionPlan}
        diagnostics={promotionPlanDiagnostics}
        editable={editable}
        promotionTargetSchema={authoringModel?.promotionTargetSchema ?? null}
        previewPayload={previewPayload}
      />

      <Stack gap={3}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.options")}
          </h3>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="plus"
            disabled={!editable}
            onClick={() => setOptionQueries([...form.optionQueries, emptyOptionQueryForm()])}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.query")}
          </Button>
        </div>
        {optionQueryDiagnostics.length > 0 ? (
          <ul className="text-sm text-danger">
            {optionQueryDiagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        ) : null}
        <Stack gap={4}>
          {form.optionQueries.map((query, index) => (
            <Stack key={query.id} gap={3}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">
                  {query.displayName.trim() ||
                    query.queryKind.trim() ||
                    t("catalog.features.sourceObservations.ui.integrationManagementPage.option.query.value", {
                      value: String(index + 1),
                    })}
                </h4>
                <Inline gap={2}>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={!editable || index === 0}
                    onClick={() => setOptionQueries(moveItem(form.optionQueries, index, index - 1))}
                  >
                    {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
                  </Button>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={!editable || index === form.optionQueries.length - 1}
                    onClick={() => setOptionQueries(moveItem(form.optionQueries, index, index + 1))}
                  >
                    {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
                  </Button>
                  <Button
                    size="sm"
                    tone="danger"
                    disabled={!editable}
                    onClick={() =>
                      setOptionQueries(form.optionQueries.filter((candidate) => candidate.id !== query.id))
                    }
                  >
                    {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                  </Button>
                </Inline>
              </div>
              <Inline gap={3}>
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.query.kind")}
                  value={query.queryKind}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { queryKind: event.currentTarget.value })}
                />
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.aliases")}
                  description={t(
                    "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated",
                  )}
                  value={query.aliasesText}
                  disabled={!editable}
                  onChange={(event) => setOptionQuery(query.id, { aliasesText: event.currentTarget.value })}
                />
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.option.display.name")}
                  value={query.displayName}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { displayName: event.currentTarget.value })}
                />
              </Inline>
              <Inline gap={3}>
                <Select
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.scope")}
                  value={query.scope}
                  disabled={!editable}
                  items={OPTION_QUERY_SCOPE_OPTIONS.filter((item) => item.value !== "__none__")}
                  onValueChange={(value) => setOptionQuery(query.id, { scope: value })}
                />
                <Select
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.scope")}
                  value={query.parentScope}
                  disabled={!editable}
                  items={OPTION_QUERY_SCOPE_OPTIONS}
                  onValueChange={(value) =>
                    setOptionQuery(query.id, {
                      parentScope: value,
                      parentRequired: value === "__none__" ? false : query.parentRequired,
                    })
                  }
                />
                <Select
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.operation")}
                  value={query.operation}
                  disabled={!editable}
                  items={OPTION_QUERY_OPERATION_OPTIONS}
                  onValueChange={(value) => setOptionQuery(query.id, { operation: value })}
                />
              </Inline>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={query.parentRequired}
                  disabled={!editable || query.parentScope === "__none__"}
                  onChange={() => setOptionQuery(query.id, { parentRequired: !query.parentRequired })}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                <span>
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.value.required")}
                </span>
              </label>
              {query.parentScope !== "__none__" ? (
                <Inline gap={3}>
                  <TextInput
                    label={t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.value.kind")}
                    value={query.parentValueKind}
                    disabled={!editable}
                    onChange={(event) => setOptionQuery(query.id, { parentValueKind: event.currentTarget.value })}
                  />
                  <TextInput
                    label={t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.diagnostic")}
                    value={query.parentDiagnosticText}
                    disabled={!editable}
                    onChange={(event) => setOptionQuery(query.id, { parentDiagnosticText: event.currentTarget.value })}
                  />
                </Inline>
              ) : null}
              <Inline gap={3}>
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.path")}
                  value={query.valuePath}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { valuePath: event.currentTarget.value })}
                />
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.label.path")}
                  value={query.labelPath}
                  disabled={!editable}
                  required
                  onChange={(event) => setOptionQuery(query.id, { labelPath: event.currentTarget.value })}
                />
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.value.path")}
                  value={query.parentValuePath}
                  disabled={!editable}
                  onChange={(event) => setOptionQuery(query.id, { parentValuePath: event.currentTarget.value })}
                />
              </Inline>
              <Inline gap={3}>
                <Select
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.description")}
                  value={query.descriptionKind}
                  disabled={!editable}
                  items={OPTION_QUERY_DESCRIPTION_KIND_OPTIONS}
                  onValueChange={(value) => setOptionQuery(query.id, { descriptionKind: value })}
                />
                {query.descriptionKind === "path" ? (
                  <TextInput
                    label={t("catalog.features.sourceObservations.ui.integrationManagementPage.description.path")}
                    value={query.descriptionPath}
                    disabled={!editable}
                    onChange={(event) => setOptionQuery(query.id, { descriptionPath: event.currentTarget.value })}
                  />
                ) : null}
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.image.url.path")}
                  value={query.imageUrlPath}
                  disabled={!editable}
                  onChange={(event) => setOptionQuery(query.id, { imageUrlPath: event.currentTarget.value })}
                />
              </Inline>
              <Textarea
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.image.url.coalesce.paths")}
                description={t(
                  "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated.paths",
                )}
                value={query.imageUrlCoalescePathsText}
                disabled={!editable}
                rows={2}
                onChange={(event) => setOptionQuery(query.id, { imageUrlCoalescePathsText: event.currentTarget.value })}
              />
              <Textarea
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.metadata.paths")}
                description={t(
                  "catalog.features.sourceObservations.ui.integrationManagementPage.one.key.path.mapping.per.line",
                )}
                value={query.metadataPathsText}
                disabled={!editable}
                rows={4}
                onChange={(event) => setOptionQuery(query.id, { metadataPathsText: event.currentTarget.value })}
              />
              <ProviderOptionQueryPreview
                providerKey={profile.providerKey}
                query={query}
                previewPayload={previewPayload}
              />
            </Stack>
          ))}
        </Stack>
      </Stack>

      {profile.validation.diagnostics.length > 0 ? (
        <DataTable
          rows={profile.validation.diagnostics}
          columns={profileValidationColumns}
          getRowId={(row, index) => `${row.path}:${index}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.validation.diagnostics")}
          density="compact"
        />
      ) : null}
      {error ? <p>{error}</p> : null}
    </Stack>
  );
}

function ProviderOptionQueryPreview({
  providerKey,
  query,
  previewPayload,
}: Readonly<{
  providerKey: string;
  query: ProfileOptionQueryForm;
  previewPayload: JsonValue | null;
}>) {
  const samplePreview = previewPayload ? providerOptionSamplePreview(query, previewPayload) : null;

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.import.surface.preview")}
      items={[
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.used.by"),
          value: providerOptionImportSurface(providerKey, query),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.behavior"),
          value: providerOptionParentPreview(query),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.output.option"),
          value: providerOptionOutputPreview(query),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.aliases"),
          value: parseListInput(query.aliasesText).join(", ") || "None",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.metadata"),
          value: providerOptionMetadataPreview(query),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.sample.output"),
          value: samplePreview ? summarizeJsonValue(samplePreview.output) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.sample.diagnostics"),
          value: samplePreview?.diagnostics.length ? samplePreview.diagnostics.join("; ") : "None",
        },
      ]}
    />
  );
}

function NormalizedObservationEditor({
  form,
  onChange,
  diagnostics,
  editable,
  authoringModel,
  previewPayload,
}: Readonly<{
  form: ProfileNormalizedObservationForm;
  onChange: (form: ProfileNormalizedObservationForm) => void;
  diagnostics: readonly string[];
  editable: boolean;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileNormalizedObservationForm>) => onChange({ ...form, ...patch });
  const setField = (id: string, patch: Partial<ProfileExpressionFieldForm>) =>
    setForm({ fields: form.fields.map((field) => (field.id === id ? { ...field, ...patch } : field)) });
  const setHashMaterial = (items: readonly ProfileExpressionListItemForm[]) => setForm({ hashMaterial: items });
  const setMergeIdentity = (items: readonly ProfileExpressionListItemForm[]) => setForm({ mergeIdentity: items });

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.normalized.observation")}
        </h3>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ fields: [...form.fields, emptyExpressionFieldForm()] })}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.field")}
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <Select
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.normalized.output.kind")}
        value={form.outputKind}
        disabled={!editable}
        items={NORMALIZED_OUTPUT_KIND_OPTIONS}
        onValueChange={(value) =>
          setForm({ outputKind: value === "pokemon-card" ? "pokemon-card" : "provider-product" })
        }
      />
      <NormalizedOutputPreview form={form} authoringModel={authoringModel} previewPayload={previewPayload} />
      <MappingExpressionEditor
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.language.expression")}
        value={form.languageCode}
        onChange={(languageCode) => setForm({ languageCode })}
        previewPayload={previewPayload}
      />
      <Stack gap={4}>
        {form.fields.map((field, index) => (
          <Stack key={field.id} gap={3}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">
                {field.fieldKey.trim() ||
                  t("catalog.features.sourceObservations.ui.integrationManagementPage.normalized.field.value", {
                    value: String(index + 1),
                  })}
              </h4>
              <Inline gap={2}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === 0}
                  onClick={() => setForm({ fields: moveItem(form.fields, index, index - 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === form.fields.length - 1}
                  onClick={() => setForm({ fields: moveItem(form.fields, index, index + 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable}
                  onClick={() =>
                    setForm({
                      fields: insertItem(form.fields, index + 1, {
                        ...field,
                        id: newFormRowId("field"),
                        fieldKey: `${field.fieldKey}Copy`,
                      }),
                    })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate")}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() => setForm({ fields: form.fields.filter((candidate) => candidate.id !== field.id) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                </Button>
              </Inline>
            </div>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.normalized.field.key")}
              value={field.fieldKey}
              disabled={!editable}
              required
              onChange={(event) => setField(field.id, { fieldKey: event.currentTarget.value })}
            />
            <MappingExpressionEditor
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.field.expression.value", {
                value: String(field.fieldKey.trim() || index + 1),
              })}
              value={field.expression}
              onChange={(expression) => setField(field.id, { expression })}
              previewPayload={previewPayload}
            />
          </Stack>
        ))}
      </Stack>
      <NormalizedExpressionListEditor
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.hash.material")}
        addLabel="Add hash expression"
        items={form.hashMaterial}
        onChange={setHashMaterial}
        editable={editable}
        previewPayload={previewPayload}
      />
      <NormalizedExpressionListEditor
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.merge.identity")}
        addLabel="Add merge expression"
        items={form.mergeIdentity}
        onChange={setMergeIdentity}
        editable={editable}
        previewPayload={previewPayload}
      />
    </Stack>
  );
}

function NormalizedOutputPreview({
  form,
  authoringModel,
  previewPayload,
}: Readonly<{
  form: ProfileNormalizedObservationForm;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  previewPayload: JsonValue | null;
}>) {
  const preview = previewPayload ? normalizedOutputPreview(form, previewPayload) : null;
  const fingerprint = authoringModel?.semanticDiff.mappingFingerprint ?? null;

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.sample.normalized.output")}
      items={[
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.output.kind"),
          value: form.outputKind,
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.language"),
          value: preview?.languageCode ?? "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fields"),
          value: preview ? summarizeJsonValue(preview.fields) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.hash.material.2"),
          value: preview ? summarizeJsonValue(preview.hashMaterial) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.merge.identity.2"),
          value: preview ? summarizeJsonValue(preview.mergeIdentity) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fingerprint.impact"),
          value: fingerprint
            ? fingerprint.changed
              ? `Changed: ${fingerprint.active ?? "none"} -> ${fingerprint.candidate ?? "none"}`
              : `Unchanged: ${fingerprint.candidate ?? "none"}`
            : "Not loaded",
        },
      ]}
    />
  );
}

function normalizedOutputPreview(form: ProfileNormalizedObservationForm, payload: JsonValue) {
  return {
    languageCode: summarizeJsonValue(previewMappingExpression(form.languageCode, payload).value),
    fields: Object.fromEntries(
      form.fields.map((field) => [
        field.fieldKey.trim() || "unnamed",
        previewMappingExpression(field.expression, payload).value,
      ]),
    ) as JsonValue,
    hashMaterial: form.hashMaterial.map((item) => previewMappingExpression(item.expression, payload).value),
    mergeIdentity: form.mergeIdentity.map((item) => previewMappingExpression(item.expression, payload).value),
  };
}

function NormalizedExpressionListEditor({
  title,
  addLabel,
  items,
  onChange,
  editable,
  previewPayload,
}: Readonly<{
  title: string;
  addLabel: string;
  items: readonly ProfileExpressionListItemForm[];
  onChange: (items: readonly ProfileExpressionListItemForm[]) => void;
  editable: boolean;
  previewPayload?: JsonValue | null;
}>) {
  const setExpression = (id: string, expression: MappingExpressionValue) =>
    onChange(items.map((item) => (item.id === id ? { ...item, expression } : item)));

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => onChange([...items, emptyExpressionListItemForm()])}
        >
          {addLabel}
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-danger">
          {title} {t("catalog.features.sourceObservations.ui.integrationManagementPage.needs.at.least.one.expression")}
        </p>
      ) : null}
      {items.map((item, index) => (
        <Stack key={item.id} gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h5 className="text-sm font-semibold text-foreground">
              {title} {t("catalog.features.sourceObservations.ui.integrationManagementPage.expression")}
              {index + 1}
            </h5>
            <Inline gap={2}>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === 0}
                onClick={() => onChange(moveItem(items, index, index - 1))}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
              </Button>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === items.length - 1}
                onClick={() => onChange(moveItem(items, index, index + 1))}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
              </Button>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable}
                onClick={() =>
                  onChange(insertItem(items, index + 1, { ...item, id: newFormRowId(title.toLowerCase()) }))
                }
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={!editable}
                onClick={() => onChange(items.filter((candidate) => candidate.id !== item.id))}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
              </Button>
            </Inline>
          </div>
          <MappingExpressionEditor
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.expression.value", {
              value0: String(title),
              value1: String(index + 1),
            })}
            value={item.expression}
            onChange={(expression) => setExpression(item.id, expression)}
            previewPayload={previewPayload}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function ExternalReferencesEditor({
  form,
  onChange,
  diagnostics,
  editable,
  authoringModel,
  previewPayload,
}: Readonly<{
  form: ProfileExternalReferencesForm;
  onChange: (form: ProfileExternalReferencesForm) => void;
  diagnostics: readonly string[];
  editable: boolean;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileExternalReferencesForm>) => onChange({ ...form, ...patch });
  const setContract = (id: string, patch: Partial<ProfileExternalReferenceForm>) =>
    setForm({
      contracts: form.contracts.map((contract) => (contract.id === id ? { ...contract, ...patch } : contract)),
    });
  const setSelectedOptionMapping = (selectedOptionMapping: ProfileSelectedOptionMappingForm | null) =>
    setForm({ selectedOptionMapping });

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.external.references.and.selected.options",
          )}
        </h3>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ contracts: [...form.contracts, emptyExternalReferenceForm()] })}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.reference")}
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <ExternalReferencePreview
        form={form}
        previewPayload={previewPayload}
        selectedOptionSchema={authoringModel?.selectedOptionSchema ?? null}
      />
      <Stack gap={4}>
        {form.contracts.map((contract, index) => (
          <Stack key={contract.id} gap={3}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">
                {contract.providerKey ||
                  t("catalog.features.sourceObservations.ui.integrationManagementPage.external.reference.value", {
                    value: String(index + 1),
                  })}
              </h4>
              <Inline gap={2}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === 0}
                  onClick={() => setForm({ contracts: moveItem(form.contracts, index, index - 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === form.contracts.length - 1}
                  onClick={() => setForm({ contracts: moveItem(form.contracts, index, index + 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable}
                  onClick={() =>
                    setForm({
                      contracts: insertItem(form.contracts, index + 1, {
                        ...contract,
                        id: newFormRowId("external-reference"),
                      }),
                    })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate")}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() =>
                    setForm({ contracts: form.contracts.filter((candidate) => candidate.id !== contract.id) })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                </Button>
              </Inline>
            </div>
            <Inline gap={3}>
              <Select
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.target")}
                value={contract.target}
                disabled={!editable}
                items={EXTERNAL_REFERENCE_TARGET_OPTIONS}
                onValueChange={(value) =>
                  setContract(contract.id, {
                    target: value === "product-reference" ? "product-reference" : "catalog-item-reference",
                    selectedOptions:
                      value === "product-reference"
                        ? (contract.selectedOptions ?? emptyExternalSelectedOptionsForm())
                        : null,
                  })
                }
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.provider.key")}
                value={contract.providerKey}
                disabled={!editable}
                required
                onChange={(event) => setContract(contract.id, { providerKey: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.external.key.prefix")}
                value={contract.externalKeyPrefix}
                disabled={!editable}
                required
                onChange={(event) => setContract(contract.id, { externalKeyPrefix: event.currentTarget.value })}
              />
              <Select
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.ambiguity.policy")}
                value={contract.ambiguityPolicy}
                disabled={!editable}
                items={EXTERNAL_REFERENCE_AMBIGUITY_OPTIONS}
                onValueChange={(value) =>
                  setContract(contract.id, {
                    ambiguityPolicy: externalReferenceAmbiguityPolicyValue(value),
                  })
                }
              />
            </Inline>
            <MappingExpressionEditor
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.source.expression")}
              value={contract.source}
              onChange={(source) => setContract(contract.id, { source })}
              previewPayload={previewPayload}
            />
            {contract.target === "product-reference" && contract.selectedOptions ? (
              <ExternalSelectedOptionsEditor
                form={contract.selectedOptions}
                onChange={(selectedOptions) => setContract(contract.id, { selectedOptions })}
                editable={editable}
                previewPayload={previewPayload}
              />
            ) : null}
          </Stack>
        ))}
      </Stack>
      <SelectedOptionMappingEditor
        form={form.selectedOptionMapping}
        onChange={setSelectedOptionMapping}
        editable={editable}
        previewPayload={previewPayload}
      />
    </Stack>
  );
}

function ExternalReferencePreview({
  form,
  previewPayload,
  selectedOptionSchema,
}: Readonly<{
  form: ProfileExternalReferencesForm;
  previewPayload: JsonValue | null;
  selectedOptionSchema: CatalogProviderProfileAuthoringModel["selectedOptionSchema"];
}>) {
  const preview = previewPayload ? externalReferencePreview(form, previewPayload, selectedOptionSchema) : null;

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.external.reference.preview")}
      items={[
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.catalog.item.references"),
          value: preview ? summarizeJsonValue(preview.catalogItemReferences) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.product.references"),
          value: preview ? summarizeJsonValue(preview.productReferences) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.evidence"),
          value: preview ? summarizeJsonValue(preview.selectedOptions) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.unknown.option.policy"),
          value:
            form.contracts
              .map((contract) => contract.selectedOptions?.missingOrUnknownOptionPolicy)
              .filter(Boolean)
              .join(", ") ||
            form.selectedOptionMapping?.missingOrUnknownOptionPolicy ||
            "Not configured",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.catalog.option.schema"),
          value: selectedOptionSchema
            ? selectedOptionSchemaSummary(form, selectedOptionSchema)
            : "Catalog schema context unavailable",
        },
      ]}
    />
  );
}

export function externalReferencePreview(
  form: ProfileExternalReferencesForm,
  payload: JsonValue,
  selectedOptionSchema: CatalogProviderProfileAuthoringModel["selectedOptionSchema"] = null,
) {
  const catalogItemReferences: JsonValue[] = [];
  const productReferences: JsonValue[] = [];
  const selectedOptions: JsonValue[] = [];

  for (const contract of form.contracts) {
    const externalKey = `${contract.externalKeyPrefix}${summarizeJsonValue(
      previewMappingExpression(contract.source, payload).value,
    )}`;
    const reference = {
      providerKey: contract.providerKey,
      externalKey,
      ambiguityPolicy: contract.ambiguityPolicy,
    };
    if (contract.target === "product-reference") {
      const options =
        contract.selectedOptions?.dimensions.map((dimension) => {
          const providerValue = previewMappingExpression(dimension.providerValue, payload).value;
          return {
            dimension: dimension.dimensionKey,
            providerValue,
            required: dimension.required,
            lookupTable: dimension.optionLookupTableKey,
            unknownOptionPolicy: contract.selectedOptions?.missingOrUnknownOptionPolicy,
            previewDisposition: selectedOptionPreviewDisposition(
              providerValue,
              contract.selectedOptions?.missingOrUnknownOptionPolicy,
              selectedOptionSchema,
              dimension.dimensionKey,
            ),
          };
        }) ?? [];
      productReferences.push({ ...reference, selectedOptions: options });
      selectedOptions.push(...options);
    } else {
      catalogItemReferences.push(reference);
    }
  }

  for (const dimension of form.selectedOptionMapping?.dimensions ?? []) {
    const providerValue = previewSelectedOptionMappingValue(dimension, payload);
    selectedOptions.push({
      dimension: dimension.dimensionKey,
      providerValue,
      required: dimension.required,
      source: dimension.providerValueSource,
      unknownOptionPolicy: form.selectedOptionMapping?.missingOrUnknownOptionPolicy,
      previewDisposition: selectedOptionPreviewDisposition(
        providerValue,
        form.selectedOptionMapping?.missingOrUnknownOptionPolicy,
        selectedOptionSchema,
        dimension.dimensionKey,
        dimension.optionAliasesText,
      ),
    });
  }

  return { catalogItemReferences, productReferences, selectedOptions };
}

function selectedOptionPreviewDisposition(
  providerValue: JsonValue,
  policy:
    | ProfileExternalSelectedOptionsForm["missingOrUnknownOptionPolicy"]
    | "leave-unmapped-review-evidence"
    | undefined,
  selectedOptionSchema: CatalogProviderProfileAuthoringModel["selectedOptionSchema"] = null,
  dimensionKey?: string,
  optionAliasesText?: string,
): string {
  const missing = providerValue === null || providerValue === "" || providerValue === undefined;
  if (!missing && selectedOptionSchema && dimensionKey) {
    const schemaDisposition = selectedOptionSchemaDisposition(
      selectedOptionSchema,
      dimensionKey,
      providerValue,
      optionAliasesText,
    );
    if (schemaDisposition) {
      return schemaDisposition;
    }
  }
  if (policy === "diagnostic") {
    return missing ? "diagnostic-missing-provider-value" : "diagnostic-if-catalog-option-unknown";
  }
  return missing ? "review-evidence-missing-provider-value" : "review-evidence-if-catalog-option-unknown";
}

function selectedOptionSchemaDisposition(
  selectedOptionSchema: NonNullable<CatalogProviderProfileAuthoringModel["selectedOptionSchema"]>,
  dimensionKey: string,
  providerValue: JsonValue,
  optionAliasesText?: string,
): string | null {
  const dimension = selectedOptionSchema.dimensions.find(
    (candidate) => normalizeSelectedOptionKey(candidate.dimensionKey) === normalizeSelectedOptionKey(dimensionKey),
  );
  if (!dimension) {
    return "catalog-dimension-missing";
  }
  if (dimension.status !== "active") {
    return "catalog-dimension-inactive";
  }

  const providerText = summarizeJsonValue(providerValue);
  const aliasedOptionKeys = selectedOptionAliasesObject(optionAliasesText ?? "")
    .filter((alias) =>
      Array.isArray(alias.providerValues)
        ? alias.providerValues.some(
            (value) => normalizeSelectedOptionKey(String(value)) === normalizeSelectedOptionKey(providerText),
          )
        : false,
    )
    .map((alias) => String(alias.optionKey ?? ""));
  const providerKeys = [providerText, ...aliasedOptionKeys].map(normalizeSelectedOptionKey).filter(Boolean);
  const option = dimension.options.find((candidate) =>
    [candidate.optionKey, candidate.optionId, candidate.optionLabel]
      .map(normalizeSelectedOptionKey)
      .some((key) => providerKeys.includes(key)),
  );

  if (!option) {
    return "catalog-option-missing";
  }

  return option.status === "active" ? "catalog-option-active" : "catalog-option-inactive";
}

function selectedOptionSchemaSummary(
  form: ProfileExternalReferencesForm,
  selectedOptionSchema: NonNullable<CatalogProviderProfileAuthoringModel["selectedOptionSchema"]>,
): string {
  const dimensionKeys = [
    ...form.contracts.flatMap(
      (contract) => contract.selectedOptions?.dimensions.map((dimension) => dimension.dimensionKey) ?? [],
    ),
    ...(form.selectedOptionMapping?.dimensions.map((dimension) => dimension.dimensionKey) ?? []),
  ].filter((dimensionKey) => dimensionKey.trim().length > 0);
  if (dimensionKeys.length === 0) {
    return "No selected option dimensions configured";
  }

  const configured = [...new Set(dimensionKeys.map((dimensionKey) => dimensionKey.trim()))];
  const activeMatches = configured.filter((dimensionKey) =>
    selectedOptionSchema.dimensions.some(
      (dimension) =>
        normalizeSelectedOptionKey(dimension.dimensionKey) === normalizeSelectedOptionKey(dimensionKey) &&
        dimension.status === "active",
    ),
  );
  const missing = configured.filter(
    (dimensionKey) =>
      !selectedOptionSchema.dimensions.some(
        (dimension) => normalizeSelectedOptionKey(dimension.dimensionKey) === normalizeSelectedOptionKey(dimensionKey),
      ),
  );
  return `${activeMatches.length}/${configured.length} active dimensions matched${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}`;
}

function normalizeSelectedOptionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function previewSelectedOptionMappingValue(
  dimension: ProfileSelectedOptionMappingDimensionForm,
  payload: JsonValue,
): JsonValue {
  if (!dimension.providerValuePath.trim()) {
    return null;
  }

  return previewMappingExpression(
    {
      selector: {
        kind: "path",
        path: dimension.providerValuePath,
        required: dimension.required,
        nullPolicy: dimension.required ? "diagnostic" : "allow-null",
      },
      owner: "external-reference",
      uses: ["selected-option"],
      redaction: "none",
    },
    payload,
  ).value;
}

function ExternalSelectedOptionsEditor({
  form,
  onChange,
  editable,
  previewPayload,
}: Readonly<{
  form: ProfileExternalSelectedOptionsForm;
  onChange: (form: ProfileExternalSelectedOptionsForm) => void;
  editable: boolean;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileExternalSelectedOptionsForm>) => onChange({ ...form, ...patch });
  const setDimension = (id: string, patch: Partial<ProfileExternalSelectedOptionDimensionForm>) =>
    setForm({
      dimensions: form.dimensions.map((dimension) => (dimension.id === id ? { ...dimension, ...patch } : dimension)),
    });

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h5 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.product.reference.selected.options")}
        </h5>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ dimensions: [...form.dimensions, emptyExternalSelectedOptionDimensionForm()] })}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.dimension")}
        </Button>
      </div>
      <Select
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.missing.or.unknown.option.policy")}
        value={form.missingOrUnknownOptionPolicy}
        disabled={!editable}
        items={SELECTED_OPTION_UNKNOWN_POLICY_OPTIONS}
        onValueChange={(value) =>
          setForm({
            missingOrUnknownOptionPolicy: value === "diagnostic" ? "diagnostic" : "leave-unmapped-review-evidence",
          })
        }
      />
      {form.dimensions.map((dimension, index) => (
        <Stack key={dimension.id} gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h6 className="text-sm font-semibold text-foreground">
              {dimension.dimensionKey ||
                t("catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.dimension.value", {
                  value: String(index + 1),
                })}
            </h6>
            <Inline gap={2}>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === 0}
                onClick={() => setForm({ dimensions: moveItem(form.dimensions, index, index - 1) })}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
              </Button>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === form.dimensions.length - 1}
                onClick={() => setForm({ dimensions: moveItem(form.dimensions, index, index + 1) })}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={!editable}
                onClick={() =>
                  setForm({ dimensions: form.dimensions.filter((candidate) => candidate.id !== dimension.id) })
                }
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
              </Button>
            </Inline>
          </div>
          <Inline gap={3}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.option.dimension.key")}
              value={dimension.dimensionKey}
              disabled={!editable}
              required
              onChange={(event) => setDimension(dimension.id, { dimensionKey: event.currentTarget.value })}
            />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.option.lookup.table.key")}
              value={dimension.optionLookupTableKey}
              disabled={!editable}
              required
              onChange={(event) => setDimension(dimension.id, { optionLookupTableKey: event.currentTarget.value })}
            />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={dimension.required}
                disabled={!editable}
                onChange={() => setDimension(dimension.id, { required: !dimension.required })}
                className="h-4 w-4 rounded border-border accent-accent"
              />
              <span>
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.required")}
              </span>
            </label>
          </Inline>
          <MappingExpressionEditor
            label={t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.value.expression.value",
              { value: String(dimension.dimensionKey || index + 1) },
            )}
            value={dimension.providerValue}
            onChange={(providerValue) => setDimension(dimension.id, { providerValue })}
            previewPayload={previewPayload}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function SelectedOptionMappingEditor({
  form,
  onChange,
  editable,
  previewPayload: _previewPayload,
}: Readonly<{
  form: ProfileSelectedOptionMappingForm | null;
  onChange: (form: ProfileSelectedOptionMappingForm | null) => void;
  editable: boolean;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileSelectedOptionMappingForm>) => {
    if (form) {
      onChange({ ...form, ...patch });
    }
  };
  const setDimension = (id: string, patch: Partial<ProfileSelectedOptionMappingDimensionForm>) => {
    if (!form) {
      return;
    }
    setForm({
      dimensions: form.dimensions.map((dimension) => (dimension.id === id ? { ...dimension, ...patch } : dimension)),
    });
  };

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.mapping")}
        </h4>
        <Button
          size="sm"
          tone="secondary"
          disabled={!editable}
          onClick={() => onChange(form ? null : emptySelectedOptionMappingForm())}
        >
          {form ? "Disable mapping" : "Enable mapping"}
        </Button>
      </div>
      {form ? (
        <Stack gap={3}>
          <Inline gap={3}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.source")}
              value={form.source}
              disabled
            />
            <TextInput
              label={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.product.reference.provider.key",
              )}
              value={form.providerKey}
              disabled={!editable}
              required
              onChange={(event) => setForm({ providerKey: event.currentTarget.value })}
            />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.product.reference.prefix")}
              value={form.externalKeyPrefix}
              disabled={!editable}
              required
              onChange={(event) => setForm({ externalKeyPrefix: event.currentTarget.value })}
            />
          </Inline>
          <Textarea
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.required.source.keys")}
            description={t("catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated")}
            value={form.requiredSourceKeysText}
            disabled={!editable}
            rows={2}
            onChange={(event) => setForm({ requiredSourceKeysText: event.currentTarget.value })}
          />
          <KeyValueList items={[{ key: "Unknown option policy", value: form.missingOrUnknownOptionPolicy }]} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h5 className="text-sm font-semibold text-foreground">
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.selected.option.dimensions")}
            </h5>
            <Button
              size="sm"
              tone="secondary"
              leadingIcon="plus"
              disabled={!editable}
              onClick={() => setForm({ dimensions: [...form.dimensions, emptySelectedOptionMappingDimensionForm()] })}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.mapping.dimension")}
            </Button>
          </div>
          {form.dimensions.map((dimension, index) => (
            <Stack key={dimension.id} gap={3}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h6 className="text-sm font-semibold text-foreground">
                  {dimension.dimensionKey ||
                    t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.dimension.value", {
                      value: String(index + 1),
                    })}
                </h6>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() =>
                    setForm({ dimensions: form.dimensions.filter((candidate) => candidate.id !== dimension.id) })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                </Button>
              </div>
              <Inline gap={3}>
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.dimension.key")}
                  value={dimension.dimensionKey}
                  disabled={!editable}
                  required
                  onChange={(event) => setDimension(dimension.id, { dimensionKey: event.currentTarget.value })}
                />
                <Select
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.value.source")}
                  value={dimension.providerValueSource}
                  disabled={!editable}
                  items={SELECTED_OPTION_PROVIDER_VALUE_SOURCE_OPTIONS}
                  onValueChange={(value) =>
                    setDimension(dimension.id, { providerValueSource: value === "payload" ? "payload" : "record" })
                  }
                />
                <TextInput
                  label={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.value.path")}
                  value={dimension.providerValuePath}
                  disabled={!editable}
                  required
                  onChange={(event) => setDimension(dimension.id, { providerValuePath: event.currentTarget.value })}
                />
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={dimension.required}
                    disabled={!editable}
                    onChange={() => setDimension(dimension.id, { required: !dimension.required })}
                    className="h-4 w-4 rounded border-border accent-accent"
                  />
                  <span>
                    {t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.dimension.required")}
                  </span>
                </label>
              </Inline>
              <Textarea
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.option.aliases")}
                description={t(
                  "catalog.features.sourceObservations.ui.integrationManagementPage.one.optionkey.value.value.mapping.per.line",
                )}
                value={dimension.optionAliasesText}
                disabled={!editable}
                rows={3}
                onChange={(event) => setDimension(dimension.id, { optionAliasesText: event.currentTarget.value })}
              />
              <Textarea
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.mappings")}
                description={t(
                  "catalog.features.sourceObservations.ui.integrationManagementPage.one.source.value.mapping.per.line",
                )}
                value={dimension.valueMappingsText}
                disabled={!editable}
                rows={3}
                onChange={(event) => setDimension(dimension.id, { valueMappingsText: event.currentTarget.value })}
              />
            </Stack>
          ))}
        </Stack>
      ) : (
        <p className="text-sm text-secondary">
          {t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.no.selected.option.mapping.is.configured.for.this",
          )}
        </p>
      )}
    </Stack>
  );
}

function ReferenceHierarchyEditor({
  form,
  onChange,
  diagnostics,
  editable,
  previewPayload,
}: Readonly<{
  form: ProfileReferenceHierarchyForm;
  onChange: (form: ProfileReferenceHierarchyForm) => void;
  diagnostics: readonly string[];
  editable: boolean;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileReferenceHierarchyForm>) => onChange({ ...form, ...patch });
  const setProviderAttribute = (id: string, patch: Partial<ProfileReferenceProviderAttributeForm>) =>
    setForm({
      providerAttributes: form.providerAttributes.map((attribute) =>
        attribute.id === id ? { ...attribute, ...patch } : attribute,
      ),
    });
  const setReferenceType = (id: string, patch: Partial<ProfileReferenceTypeRuleForm>) =>
    setForm({
      referenceTypes: form.referenceTypes.map((type) => (type.id === id ? { ...type, ...patch } : type)),
    });
  const setRecordRule = (id: string, patch: Partial<ProfileReferenceRecordRuleForm>) =>
    setForm({
      recordRules: form.recordRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  const setContract = (id: string, patch: Partial<ProfileReferenceHierarchyContractForm>) =>
    setForm({
      contracts: form.contracts.map((contract) => (contract.id === id ? { ...contract, ...patch } : contract)),
    });

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.hierarchy")}
        </h3>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ contracts: [...form.contracts, emptyReferenceHierarchyContractForm()] })}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.hierarchy.chain")}
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <Inline gap={3}>
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.reference.id.prefix")}
          value={form.providerReferenceIdPrefix}
          disabled={!editable}
          required
          onChange={(event) => setForm({ providerReferenceIdPrefix: event.currentTarget.value })}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.target.record.rule.key")}
          value={form.targetRecordRuleKey}
          disabled={!editable}
          required
          onChange={(event) => setForm({ targetRecordRuleKey: event.currentTarget.value })}
        />
      </Inline>
      <ReferenceHierarchyPreview form={form} previewPayload={previewPayload} />
      <Stack gap={3}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.attributes")}
          </h4>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="plus"
            disabled={!editable}
            onClick={() => setForm({ providerAttributes: [...form.providerAttributes, emptyProviderAttributeForm()] })}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.provider.attribute")}
          </Button>
        </div>
        {form.providerAttributes.map((attribute) => (
          <Inline key={attribute.id} gap={3}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.attribute.type.key")}
              value={attribute.typeKey}
              disabled={!editable}
              required
              onChange={(event) => setProviderAttribute(attribute.id, { typeKey: event.currentTarget.value })}
            />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.attribute.key")}
              value={attribute.providerAttributeKey}
              disabled={!editable}
              required
              onChange={(event) =>
                setProviderAttribute(attribute.id, { providerAttributeKey: event.currentTarget.value })
              }
            />
            <Button
              size="sm"
              tone="danger"
              disabled={!editable}
              onClick={() =>
                setForm({
                  providerAttributes: form.providerAttributes.filter((candidate) => candidate.id !== attribute.id),
                })
              }
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
            </Button>
          </Inline>
        ))}
      </Stack>
      <Stack gap={3}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.types")}
          </h4>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="plus"
            disabled={!editable}
            onClick={() => setForm({ referenceTypes: [...form.referenceTypes, emptyReferenceTypeRuleForm()] })}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.reference.type")}
          </Button>
        </div>
        {form.referenceTypes.map((type) => (
          <Stack key={type.id} gap={3}>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.type.id")}
                value={type.referenceTypeId}
                disabled={!editable}
                required
                onChange={(event) => setReferenceType(type.id, { referenceTypeId: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.type.key")}
                value={type.typeKey}
                disabled={!editable}
                required
                onChange={(event) => setReferenceType(type.id, { typeKey: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.type.name")}
                value={type.name}
                disabled={!editable}
                required
                onChange={(event) => setReferenceType(type.id, { name: event.currentTarget.value })}
              />
              <Button
                size="sm"
                tone="danger"
                disabled={!editable}
                onClick={() =>
                  setForm({ referenceTypes: form.referenceTypes.filter((candidate) => candidate.id !== type.id) })
                }
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
              </Button>
            </Inline>
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.type.description")}
              value={type.descriptionText}
              disabled={!editable}
              rows={2}
              onChange={(event) => setReferenceType(type.id, { descriptionText: event.currentTarget.value })}
            />
            <Textarea
              label={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.reference.type.attribute.keys",
              )}
              description={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated",
              )}
              value={type.attributeKeysText}
              disabled={!editable}
              rows={2}
              onChange={(event) => setReferenceType(type.id, { attributeKeysText: event.currentTarget.value })}
            />
          </Stack>
        ))}
      </Stack>
      <Stack gap={3}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.record.rules")}
          </h4>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="plus"
            disabled={!editable}
            onClick={() => setForm({ recordRules: [...form.recordRules, emptyReferenceRecordRuleForm()] })}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.record.rule")}
          </Button>
        </div>
        {form.recordRules.map((rule) => (
          <Stack key={rule.id} gap={3}>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.record.rule.key")}
                value={rule.ruleKey}
                disabled={!editable}
                required
                onChange={(event) => setRecordRule(rule.id, { ruleKey: event.currentTarget.value })}
              />
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.record.type.key")}
                value={rule.typeKey}
                disabled={!editable}
                required
                onChange={(event) => setRecordRule(rule.id, { typeKey: event.currentTarget.value })}
              />
              <Button
                size="sm"
                tone="danger"
                disabled={!editable}
                onClick={() =>
                  setForm({ recordRules: form.recordRules.filter((candidate) => candidate.id !== rule.id) })
                }
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
              </Button>
            </Inline>
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.required.paths")}
              description={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated",
              )}
              value={rule.requiredPathsText}
              disabled={!editable}
              rows={2}
              onChange={(event) => setRecordRule(rule.id, { requiredPathsText: event.currentTarget.value })}
            />
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.relationships")}
              description={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.one.relationshiptype.rulekey.mapping.per.line.use.relationshiptype",
              )}
              value={rule.relationshipsText}
              disabled={!editable}
              rows={3}
              onChange={(event) => setRecordRule(rule.id, { relationshipsText: event.currentTarget.value })}
            />
            <ReferenceRecordIdRuleEditor
              form={rule}
              editable={editable}
              onChange={(patch) => setRecordRule(rule.id, patch)}
            />
            <Inline gap={3}>
              <ReferenceValueRuleEditor
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.record.key")}
                value={rule.keyRule}
                editable={editable}
                onChange={(keyRule) => setRecordRule(rule.id, { keyRule })}
              />
              <ReferenceValueRuleEditor
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.record.name")}
                value={rule.nameRule}
                editable={editable}
                onChange={(nameRule) => setRecordRule(rule.id, { nameRule })}
              />
            </Inline>
            <ReferenceValueRuleEditor
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.record.description")}
              value={rule.descriptionRule}
              editable={editable}
              onChange={(descriptionRule) => setRecordRule(rule.id, { descriptionRule })}
            />
            <ReferenceAttributeRulesEditor
              attributes={rule.attributes}
              editable={editable}
              onChange={(attributes) => setRecordRule(rule.id, { attributes })}
            />
          </Stack>
        ))}
      </Stack>
      <Stack gap={4}>
        {form.contracts.map((contract, index) => (
          <Stack key={contract.id} gap={3}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.hierarchy.chain")}
                {index + 1}: {referenceHierarchyChainSummary(contract)}
              </h4>
              <Inline gap={2}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === 0}
                  onClick={() => setForm({ contracts: moveItem(form.contracts, index, index - 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === form.contracts.length - 1}
                  onClick={() => setForm({ contracts: moveItem(form.contracts, index, index + 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() =>
                    setForm({ contracts: form.contracts.filter((candidate) => candidate.id !== contract.id) })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                </Button>
              </Inline>
            </div>
            <ReferenceHierarchyNodeEditor
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.target.reference.record")}
              node={contract}
              editable={editable}
              previewPayload={previewPayload}
              onChange={(patch) => setContract(contract.id, patch)}
            />
            <ReferenceHierarchyParentsEditor
              parents={contract.parents}
              editable={editable}
              previewPayload={previewPayload}
              onChange={(parents) => setContract(contract.id, { parents })}
            />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

function ReferenceRecordIdRuleEditor({
  form,
  editable,
  onChange,
}: Readonly<{
  form: ProfileReferenceRecordRuleForm;
  editable: boolean;
  onChange: (patch: Partial<ProfileReferenceRecordRuleForm>) => void;
}>) {
  return (
    <Stack gap={3}>
      <h5 className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.record.id")}
      </h5>
      <Inline gap={3}>
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.record.id.strategy")}
          value={form.recordIdKind}
          disabled={!editable}
          items={REFERENCE_RECORD_ID_KIND_OPTIONS}
          onValueChange={(recordIdKind) =>
            onChange({ recordIdKind: recordIdKind === "static" ? "static" : "provider" })
          }
        />
        {form.recordIdKind === "static" ? (
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.static.reference.record.id")}
            value={form.staticReferenceRecordId}
            disabled={!editable}
            required
            onChange={(event) => onChange({ staticReferenceRecordId: event.currentTarget.value })}
          />
        ) : (
          <>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.record.type.key")}
              value={form.providerRecordTypeKey}
              disabled={!editable}
              required
              onChange={(event) => onChange({ providerRecordTypeKey: event.currentTarget.value })}
            />
            <Textarea
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.value.paths")}
              description={t(
                "catalog.features.sourceObservations.ui.integrationManagementPage.comma.or.line.separated.first.available.value.becomes",
              )}
              value={form.providerValuePathsText}
              disabled={!editable}
              rows={2}
              onChange={(event) => onChange({ providerValuePathsText: event.currentTarget.value })}
            />
          </>
        )}
      </Inline>
    </Stack>
  );
}

function ReferenceValueRuleEditor({
  label,
  value,
  editable,
  onChange,
}: Readonly<{
  label: string;
  value: ProfileReferenceValueRuleForm;
  editable: boolean;
  onChange: (value: ProfileReferenceValueRuleForm) => void;
}>) {
  const setValue = (patch: Partial<ProfileReferenceValueRuleForm>) => onChange({ ...value, ...patch });

  return (
    <Stack gap={3}>
      <h5 className="text-sm font-semibold text-foreground">{label}</h5>
      <Inline gap={3}>
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.source", {
            value: String(label),
          })}
          value={value.kind}
          disabled={!editable}
          items={REFERENCE_VALUE_RULE_KIND_OPTIONS}
          onValueChange={(kind) => setValue({ kind: kind === "path" || kind === "template" ? kind : "static" })}
        />
        {value.kind === "static" ? (
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.static.value")}
            value={value.staticValue}
            disabled={!editable}
            required
            onChange={(event) => setValue({ staticValue: event.currentTarget.value })}
          />
        ) : null}
        {value.kind === "path" ? (
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.payload.path")}
            value={value.path}
            disabled={!editable}
            required
            onChange={(event) => setValue({ path: event.currentTarget.value })}
          />
        ) : null}
      </Inline>
      {value.kind === "template" ? (
        <>
          <Textarea
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.template")}
            description={t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.use.value.tokens.sourced.by.the.template.values",
            )}
            value={value.template}
            disabled={!editable}
            rows={2}
            onChange={(event) => setValue({ template: event.currentTarget.value })}
          />
          <Textarea
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.template.values")}
            description={t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.one.token.path.path.to.value.or.token",
            )}
            value={value.templateValuesText}
            disabled={!editable}
            rows={3}
            onChange={(event) => setValue({ templateValuesText: event.currentTarget.value })}
          />
        </>
      ) : null}
    </Stack>
  );
}

function ReferenceAttributeRulesEditor({
  attributes,
  editable,
  onChange,
}: Readonly<{
  attributes: readonly ProfileReferenceAttributeRuleForm[];
  editable: boolean;
  onChange: (attributes: readonly ProfileReferenceAttributeRuleForm[]) => void;
}>) {
  const setAttribute = (id: string, patch: Partial<ProfileReferenceAttributeRuleForm>) =>
    onChange(attributes.map((attribute) => (attribute.id === id ? { ...attribute, ...patch } : attribute)));

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h5 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.record.attributes")}
        </h5>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => onChange([...attributes, emptyReferenceAttributeRuleForm()])}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.attribute.rule")}
        </Button>
      </div>
      {attributes.length === 0 ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.no.attribute.rules")}
        </p>
      ) : null}
      {attributes.map((attribute, index) => (
        <Stack key={attribute.id} gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h6 className="text-sm font-semibold text-foreground">
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.attribute")}
              {index + 1}: {attribute.attributeKey || "Unconfigured"}
            </h6>
            <Button
              size="sm"
              tone="danger"
              disabled={!editable}
              onClick={() => onChange(attributes.filter((candidate) => candidate.id !== attribute.id))}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
            </Button>
          </div>
          <Inline gap={3}>
            <TextInput
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.attribute.key")}
              value={attribute.attributeKey}
              disabled={!editable}
              required
              onChange={(event) => setAttribute(attribute.id, { attributeKey: event.currentTarget.value })}
            />
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={attribute.optional}
                disabled={!editable}
                onChange={() => setAttribute(attribute.id, { optional: !attribute.optional })}
                className="h-4 w-4 rounded border-border accent-accent"
              />
              <span>{t("catalog.features.sourceObservations.ui.integrationManagementPage.optional.attribute")}</span>
            </label>
          </Inline>
          <ReferenceValueRuleEditor
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.attribute.value")}
            value={attribute.valueRule}
            editable={editable}
            onChange={(valueRule) => setAttribute(attribute.id, { valueRule })}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function ReferenceHierarchyPreview({
  form,
  previewPayload,
}: Readonly<{
  form: ProfileReferenceHierarchyForm;
  previewPayload: JsonValue | null;
}>) {
  const preview = previewPayload ? referenceHierarchyPreview(form, previewPayload) : [];
  const diagnostics = preview.flatMap((record, index) => [
    ...record.diagnostics.map((diagnostic) => `Chain ${index + 1}: ${diagnostic}`),
    ...record.parentChain.flatMap((parent, parentIndex) =>
      parent.diagnostics.map((diagnostic) => `Chain ${index + 1} parent ${parentIndex + 1}: ${diagnostic}`),
    ),
  ]);

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.reference.hierarchy.preview")}
      items={[
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.target.record.rule"),
          value: form.targetRecordRuleKey || "Not configured",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provider.attributes.2"),
          value:
            form.providerAttributes
              .map((attribute) => `${attribute.typeKey || "type"}=${attribute.providerAttributeKey || "provider-key"}`)
              .join(", ") || "No provider attributes",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.provisioned.records"),
          value: previewPayload ? summarizeJsonValue(preview) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.preview.diagnostics"),
          value: diagnostics.length > 0 ? diagnostics.join("; ") : "None",
        },
      ]}
    />
  );
}

export function referenceHierarchyPreview(
  form: ProfileReferenceHierarchyForm,
  payload: JsonValue,
): readonly ReferenceHierarchyPreviewRecord[] {
  return form.contracts.map((contract) => {
    const targetPreview = previewMappingExpression(contract.referenceRecordKey, payload);
    const parentChain = contract.parents.map((parent) => {
      const parentPreview = previewMappingExpression(parent.referenceRecordKey, payload);
      return {
        typeKey: parent.targetTypeKey,
        providerAttributeKey: parent.providerAttributeKey,
        referenceRecordKey: parentPreview.value,
        deterministicId: referenceHierarchyPreviewId(form, parent.targetTypeKey, parentPreview.value),
        diagnostics: parentPreview.diagnostics,
      };
    });

    return {
      typeKey: contract.targetTypeKey,
      providerAttributeKey: contract.providerAttributeKey,
      referenceRecordKey: targetPreview.value,
      deterministicId: referenceHierarchyPreviewId(form, contract.targetTypeKey, targetPreview.value),
      parentChain,
      diagnostics: targetPreview.diagnostics,
    };
  });
}

function referenceHierarchyPreviewId(
  form: ProfileReferenceHierarchyForm,
  typeKey: string,
  referenceRecordKey: JsonValue,
): string {
  const normalizedKey = normalizeReferenceHierarchyPreviewKey(referenceRecordKey);
  if (!form.providerReferenceIdPrefix.trim() || !typeKey.trim() || !normalizedKey) {
    return "Not available";
  }
  return `${form.providerReferenceIdPrefix.trim()}_${typeKey.trim()}_${normalizedKey.replace(/-/g, "_")}`;
}

function normalizeReferenceHierarchyPreviewKey(value: JsonValue): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "";
  }
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function ReferenceHierarchyNodeEditor({
  label,
  node,
  editable,
  previewPayload,
  onChange,
}: Readonly<{
  label: string;
  node: Pick<ProfileReferenceHierarchyContractForm, "targetTypeKey" | "providerAttributeKey" | "referenceRecordKey">;
  editable: boolean;
  previewPayload: JsonValue | null;
  onChange: (patch: Partial<ProfileReferenceHierarchyContractForm>) => void;
}>) {
  return (
    <Stack gap={3}>
      <h5 className="text-sm font-semibold text-foreground">{label}</h5>
      <Inline gap={3}>
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.hierarchy.target.type.key")}
          value={node.targetTypeKey}
          disabled={!editable}
          required
          onChange={(event) => onChange({ targetTypeKey: event.currentTarget.value })}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.hierarchy.provider.attribute.key")}
          value={node.providerAttributeKey}
          disabled={!editable}
          required
          onChange={(event) => onChange({ providerAttributeKey: event.currentTarget.value })}
        />
      </Inline>
      <MappingExpressionEditor
        label={t("catalog.features.sourceObservations.ui.integrationManagementPage.value.key.expression", {
          value: String(label),
        })}
        value={node.referenceRecordKey}
        onChange={(referenceRecordKey) => onChange({ referenceRecordKey })}
        previewPayload={previewPayload}
      />
    </Stack>
  );
}

function ReferenceHierarchyParentsEditor({
  parents,
  editable,
  previewPayload,
  onChange,
}: Readonly<{
  parents: readonly ProfileReferenceHierarchyParentForm[];
  editable: boolean;
  previewPayload: JsonValue | null;
  onChange: (parents: readonly ProfileReferenceHierarchyParentForm[]) => void;
}>) {
  const setParent = (id: string, patch: Partial<ProfileReferenceHierarchyParentForm>) =>
    onChange(parents.map((parent) => (parent.id === id ? { ...parent, ...patch } : parent)));

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h5 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.chain")}
        </h5>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => onChange([...parents, emptyReferenceHierarchyParentForm()])}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.parent")}
        </Button>
      </div>
      {parents.length === 0 ? (
        <p className="text-sm text-secondary">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.no.parent.reference.records")}
        </p>
      ) : null}
      {parents.map((parent, index) => (
        <Stack key={parent.id} gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h6 className="text-sm font-semibold text-foreground">
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.parent")}
              {index + 1}: {parent.targetTypeKey || "Unconfigured"}
            </h6>
            <Inline gap={2}>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === 0}
                onClick={() => onChange(moveItem(parents, index, index - 1))}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
              </Button>
              <Button
                size="sm"
                tone="secondary"
                disabled={!editable || index === parents.length - 1}
                onClick={() => onChange(moveItem(parents, index, index + 1))}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={!editable}
                onClick={() => onChange(parents.filter((candidate) => candidate.id !== parent.id))}
              >
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
              </Button>
            </Inline>
          </div>
          <ReferenceHierarchyNodeEditor
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.parent.reference.record.value", {
              value: String(index + 1),
            })}
            node={parent}
            editable={editable}
            previewPayload={previewPayload}
            onChange={(patch) => setParent(parent.id, patch as Partial<ProfileReferenceHierarchyParentForm>)}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function DuplicatePreventionEditor({
  form,
  onChange,
  diagnostics,
  editable,
  previewPayload,
}: Readonly<{
  form: ProfileDuplicatePreventionForm;
  onChange: (form: ProfileDuplicatePreventionForm) => void;
  diagnostics: readonly string[];
  editable: boolean;
  previewPayload: JsonValue | null;
}>) {
  const setForm = (patch: Partial<ProfileDuplicatePreventionForm>) => onChange({ ...form, ...patch });
  const setRule = (id: string, patch: Partial<ProfileDuplicatePreventionRuleForm>) =>
    setForm({ identityRules: form.identityRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) });

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate.prevention")}
        </h3>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ identityRules: [...form.identityRules, emptyDuplicatePreventionRuleForm()] })}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.identity.rule")}
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <Inline gap={3}>
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.ambiguous.candidate.policy")}
          value={form.ambiguousCandidatePolicy}
          disabled={!editable}
          items={DUPLICATE_PREVENTION_AMBIGUOUS_POLICY_OPTIONS}
          onValueChange={(value) =>
            setForm({ ambiguousCandidatePolicy: value === "review-only" ? "review-only" : "block-promotion" })
          }
        />
        <Select
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.replay.policy")}
          value={form.replayPolicy}
          disabled={!editable}
          items={DUPLICATE_PREVENTION_REPLAY_POLICY_OPTIONS}
          onValueChange={(value) =>
            setForm({
              replayPolicy:
                value === "operator-reapply-active-version"
                  ? "operator-reapply-active-version"
                  : "same-profile-version",
            })
          }
        />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={form.exactExternalCatalogItemReferencesFirst}
            disabled={!editable}
            onChange={() =>
              setForm({ exactExternalCatalogItemReferencesFirst: !form.exactExternalCatalogItemReferencesFirst })
            }
            className="h-4 w-4 rounded border-border accent-accent"
          />
          <span>
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.exact.external.references.first")}
          </span>
        </label>
      </Inline>
      <DuplicatePreventionPreview form={form} previewPayload={previewPayload} />
      <NormalizedExpressionListEditor
        title={t("catalog.features.sourceObservations.ui.integrationManagementPage.merge.candidate.evidence")}
        addLabel="Add merge evidence"
        items={form.mergeCandidateEvidence}
        onChange={(mergeCandidateEvidence) => setForm({ mergeCandidateEvidence })}
        editable={editable}
        previewPayload={previewPayload}
      />
      <Stack gap={4}>
        {form.identityRules.map((rule, index) => (
          <Stack key={rule.id} gap={3}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.rule")} {index + 1}:{" "}
                {rule.ruleKey || rule.ruleKind}
              </h4>
              <Inline gap={2}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === 0}
                  onClick={() => setForm({ identityRules: moveItem(form.identityRules, index, index - 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === form.identityRules.length - 1}
                  onClick={() => setForm({ identityRules: moveItem(form.identityRules, index, index + 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable}
                  onClick={() =>
                    setForm({
                      identityRules: insertItem(form.identityRules, index + 1, {
                        ...rule,
                        id: newFormRowId("duplicate-rule"),
                        ruleKey: `${rule.ruleKey}Copy`,
                      }),
                    })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate")}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() =>
                    setForm({ identityRules: form.identityRules.filter((candidate) => candidate.id !== rule.id) })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                </Button>
              </Inline>
            </div>
            <Inline gap={3}>
              <TextInput
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate.rule.key")}
                value={rule.ruleKey}
                disabled={!editable}
                required
                onChange={(event) => setRule(rule.id, { ruleKey: event.currentTarget.value })}
              />
              <Select
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate.rule.kind")}
                value={rule.ruleKind}
                disabled={!editable}
                items={DUPLICATE_PREVENTION_RULE_KIND_OPTIONS}
                onValueChange={(value) => setRule(rule.id, { ruleKind: duplicatePreventionRuleKindValue(value) })}
              />
              <Select
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.candidate.policy")}
                value={rule.candidatePolicy}
                disabled={!editable}
                items={DUPLICATE_PREVENTION_CANDIDATE_POLICY_OPTIONS}
                onValueChange={(value) =>
                  setRule(rule.id, { candidatePolicy: value === "review-only" ? "review-only" : "reuse" })
                }
              />
            </Inline>
            <NormalizedExpressionListEditor
              title={t("catalog.features.sourceObservations.ui.integrationManagementPage.rule.evidence.value", {
                value: String(rule.ruleKey || index + 1),
              })}
              addLabel="Add rule evidence"
              items={rule.evidence}
              onChange={(evidence) => setRule(rule.id, { evidence })}
              editable={editable}
              previewPayload={previewPayload}
            />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

function DuplicatePreventionPreview({
  form,
  previewPayload,
}: Readonly<{
  form: ProfileDuplicatePreventionForm;
  previewPayload: JsonValue | null;
}>) {
  const preview = previewPayload ? duplicatePreventionPreview(form, previewPayload) : null;

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate.prevention.preview")}
      items={[
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.ambiguous.candidates"),
          value: duplicatePreventionPolicyLabel(form.ambiguousCandidatePolicy),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.rule.order"),
          value: form.identityRules.map((rule, index) => `${index + 1}. ${rule.ruleKey || rule.ruleKind}`).join("; "),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.merge.evidence"),
          value: preview ? summarizeJsonValue(preview.mergeCandidateEvidence) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.identity.evidence"),
          value: preview ? summarizeJsonValue(preview.identityRules) : "No fixture sample",
        },
      ]}
    />
  );
}

export function duplicatePreventionPreview(form: ProfileDuplicatePreventionForm, payload: JsonValue) {
  return {
    policy: {
      ambiguousCandidatePolicy: form.ambiguousCandidatePolicy,
      replayPolicy: form.replayPolicy,
      exactExternalCatalogItemReferencesFirst: form.exactExternalCatalogItemReferencesFirst,
    },
    mergeCandidateEvidence: form.mergeCandidateEvidence.map(
      (item) => previewMappingExpression(item.expression, payload).value,
    ),
    identityRules: form.identityRules.map((rule, index) => ({
      order: index + 1,
      ruleKey: rule.ruleKey,
      ruleKind: rule.ruleKind,
      candidatePolicy: rule.candidatePolicy,
      ambiguousOutcome:
        form.ambiguousCandidatePolicy === "block-promotion" ? "blocks-ambiguous-candidates" : "review-only",
      evidence: rule.evidence.map((item) => previewMappingExpression(item.expression, payload).value),
    })),
  };
}

function PromotionPlanEditor({
  profile,
  form,
  onChange,
  diagnostics,
  editable,
  promotionTargetSchema,
  previewPayload,
}: Readonly<{
  profile: CatalogProviderProfileVersionReview;
  form: ProfilePromotionPlanForm;
  onChange: (form: ProfilePromotionPlanForm) => void;
  diagnostics: readonly string[];
  editable: boolean;
  promotionTargetSchema: CatalogProviderProfileAuthoringModel["promotionTargetSchema"];
  previewPayload: JsonValue | null;
}>) {
  const [serverDryRunResult, setServerDryRunResult] = useState<CatalogProviderProfileDryRunResult | null>(null);
  const [serverDryRunError, setServerDryRunError] = useState<string | null>(null);
  const [serverDryRunning, setServerDryRunning] = useState(false);
  const setForm = (patch: Partial<ProfilePromotionPlanForm>) => onChange({ ...form, ...patch });
  const setCommand = (id: string, patch: Partial<ProfilePromotionCommandForm>) =>
    setForm({ commands: form.commands.map((command) => (command.id === id ? { ...command, ...patch } : command)) });
  const runServerComparison = async () => {
    if (!previewPayload) {
      return;
    }

    setServerDryRunning(true);
    setServerDryRunError(null);
    try {
      const result = await dryRunSourceObservationProviderProfile(
        profile.providerKey,
        profile.profileVersion,
        previewPayload,
      );
      setServerDryRunResult(result);
    } catch (error) {
      setServerDryRunResult(null);
      setServerDryRunError(error instanceof Error ? error.message : "Server dry-run comparison failed.");
    } finally {
      setServerDryRunning(false);
    }
  };

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.command.plan")}
        </h3>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => setForm({ commands: [...form.commands, emptyPromotionCommandForm()] })}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.command")}
        </Button>
      </div>
      {diagnostics.length > 0 ? (
        <ul className="text-sm text-danger">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      <KeyValueList
        items={[
          { key: "Plan kind", value: form.planKind },
          { key: "Requires review", value: "Yes" },
        ]}
      />
      <PromotionPlanPreview form={form} promotionTargetSchema={promotionTargetSchema} previewPayload={previewPayload} />
      <Stack gap={2}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground">
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.server.dry.run.comparison")}
          </h4>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="play"
            loading={serverDryRunning}
            disabled={!previewPayload}
            onClick={runServerComparison}
          >
            {t("catalog.features.sourceObservations.ui.integrationManagementPage.compare.server.plan")}
          </Button>
        </div>
        {serverDryRunError ? <p className="text-sm text-danger">{serverDryRunError}</p> : null}
        <TaskSummary
          title={t("catalog.features.sourceObservations.ui.integrationManagementPage.server.promotion.command.plan")}
          items={[
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
              value: serverDryRunResult?.status ?? "Not compared",
            },
            {
              label: t("catalog.features.sourceObservations.ui.integrationManagementPage.planned.commands"),
              value: serverDryRunResult
                ? summarizeJsonValue(serverDryRunResult.promotionCommandPlan.commands as unknown as JsonValue)
                : "Run comparison",
            },
          ]}
        />
      </Stack>
      <Stack gap={4}>
        {form.commands.map((command, index) => (
          <Stack key={command.id} gap={3}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-foreground">
                {t("catalog.features.sourceObservations.ui.integrationManagementPage.command")} {index + 1}:{" "}
                {command.commandName}
              </h4>
              <Inline gap={2}>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === 0}
                  onClick={() => setForm({ commands: moveItem(form.commands, index, index - 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.up")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable || index === form.commands.length - 1}
                  onClick={() => setForm({ commands: moveItem(form.commands, index, index + 1) })}
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.down")}
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={!editable}
                  onClick={() =>
                    setForm({
                      commands: insertItem(form.commands, index + 1, {
                        ...command,
                        id: newFormRowId("promotion-command"),
                      }),
                    })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate")}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={!editable}
                  onClick={() =>
                    setForm({ commands: form.commands.filter((candidate) => candidate.id !== command.id) })
                  }
                >
                  {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
                </Button>
              </Inline>
            </div>
            <Select
              label={t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.command.name")}
              value={command.commandName}
              disabled={!editable}
              items={PROMOTION_COMMAND_NAME_OPTIONS}
              onValueChange={(value) =>
                setCommand(command.id, {
                  commandName: promotionCommandNameValue(value),
                  unsupportedCommandName: null,
                })
              }
            />
            <KeyValueList
              density="compact"
              variant="plain"
              items={[
                {
                  key: "Required inputs",
                  value: promotionCommandRequiredInputKeys(command.commandName).join(", ") || "None",
                },
              ]}
            />
            <PromotionCommandInputsEditor
              command={command}
              editable={editable}
              previewPayload={previewPayload}
              onChange={(inputs) => setCommand(command.id, { inputs })}
            />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

function PromotionPlanPreview({
  form,
  promotionTargetSchema,
  previewPayload,
}: Readonly<{
  form: ProfilePromotionPlanForm;
  promotionTargetSchema: CatalogProviderProfileAuthoringModel["promotionTargetSchema"];
  previewPayload: JsonValue | null;
}>) {
  const preview = previewPayload ? promotionPlanPreview(form, previewPayload, promotionTargetSchema) : null;

  return (
    <TaskSummary
      title={t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.command.preview")}
      items={[
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.command.count"),
          value: String(form.commands.length),
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.ordered.commands"),
          value: form.commands.map((command, index) => `${index + 1}. ${command.commandName}`).join("; ") || "None",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.command.inputs"),
          value: preview ? summarizeJsonValue(preview.commands) : "No fixture sample",
        },
        {
          label: t("catalog.features.sourceObservations.ui.integrationManagementPage.resolved.catalog.targets"),
          value: preview ? summarizeJsonValue(preview.resolvedTargets) : "No fixture sample",
        },
      ]}
    />
  );
}

export function promotionPlanPreview(
  form: ProfilePromotionPlanForm,
  payload: JsonValue,
  promotionTargetSchema: CatalogProviderProfileAuthoringModel["promotionTargetSchema"] = null,
) {
  const commands = form.commands.map((command, index) => {
    const inputs = Object.fromEntries(
      command.inputs.map((input) => [
        input.fieldKey.trim() || "unnamed",
        previewMappingExpression(input.expression, payload).value,
      ]),
    ) as Record<string, JsonValue>;
    return {
      order: index + 1,
      commandName: command.commandName,
      requiredInputs: promotionCommandRequiredInputKeys(command.commandName),
      inputs: inputs as JsonValue,
      resolvedTargets: promotionCommandResolvedTargets(command.commandName, inputs, promotionTargetSchema),
    };
  });

  return {
    planKind: form.planKind,
    requiresReview: form.requiresReview,
    commands,
    resolvedTargets: commands.flatMap((command) => command.resolvedTargets),
  };
}

function promotionCommandResolvedTargets(
  commandName: ProfilePromotionCommandForm["commandName"],
  inputs: Record<string, JsonValue>,
  promotionTargetSchema: CatalogProviderProfileAuthoringModel["promotionTargetSchema"],
) {
  if (!promotionTargetSchema) {
    return [];
  }

  const targetSpecs =
    commandName === "AssignBlueprintToCatalogItem"
      ? [{ inputKey: "blueprintKey", targetKind: "blueprint", records: promotionTargetSchema.blueprints }]
      : commandName === "AssignCatalogItemToCategory"
        ? [{ inputKey: "categoryKey", targetKind: "category", records: promotionTargetSchema.categories }]
        : commandName === "SetCatalogItemFieldValue"
          ? [{ inputKey: "fieldKey", targetKind: "field", records: promotionTargetSchema.fields }]
          : [];

  return targetSpecs.map((spec) => {
    const inputValue = inputs[spec.inputKey];
    const target = spec.records.find(
      (record) => normalizeSelectedOptionKey(record.key) === normalizeSelectedOptionKey(summarizeJsonValue(inputValue)),
    );
    return {
      inputKey: spec.inputKey,
      targetKind: spec.targetKind,
      key: summarizeJsonValue(inputValue),
      targetId: target?.id ?? null,
      targetName: target?.name ?? null,
      status: target?.status ?? "missing",
      disposition: target
        ? target.status === "active"
          ? "catalog-target-active"
          : "catalog-target-inactive"
        : "catalog-target-missing",
    };
  });
}

export function promotionCommandRequiredInputKeys(
  commandName: ProfilePromotionCommandForm["commandName"],
): readonly string[] {
  return PROMOTION_COMMAND_REQUIRED_INPUTS[commandName] ?? [];
}

function PromotionCommandInputsEditor({
  command,
  editable,
  previewPayload,
  onChange,
}: Readonly<{
  command: ProfilePromotionCommandForm;
  editable: boolean;
  previewPayload: JsonValue | null;
  onChange: (inputs: readonly ProfileExpressionFieldForm[]) => void;
}>) {
  const setInput = (id: string, patch: Partial<ProfileExpressionFieldForm>) =>
    onChange(command.inputs.map((input) => (input.id === id ? { ...input, ...patch } : input)));

  return (
    <Stack gap={3}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h5 className="text-sm font-semibold text-foreground">
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.command.inputs")}
        </h5>
        <Button
          size="sm"
          tone="secondary"
          leadingIcon="plus"
          disabled={!editable}
          onClick={() => onChange([...command.inputs, emptyPromotionCommandInputForm()])}
        >
          {t("catalog.features.sourceObservations.ui.integrationManagementPage.add.input")}
        </Button>
      </div>
      {command.inputs.map((input, index) => (
        <Stack key={input.id} gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h6 className="text-sm font-semibold text-foreground">
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.input")}
              {index + 1}: {input.fieldKey || "Unnamed"}
            </h6>
            <Button
              size="sm"
              tone="danger"
              disabled={!editable}
              onClick={() => onChange(command.inputs.filter((candidate) => candidate.id !== input.id))}
            >
              {t("catalog.features.sourceObservations.ui.integrationManagementPage.remove")}
            </Button>
          </div>
          <TextInput
            label={t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.input.key")}
            value={input.fieldKey}
            disabled={!editable}
            required
            onChange={(event) => setInput(input.id, { fieldKey: event.currentTarget.value })}
          />
          <MappingExpressionEditor
            label={t(
              "catalog.features.sourceObservations.ui.integrationManagementPage.promotion.input.expression.value",
              { value: String(input.fieldKey || index + 1) },
            )}
            value={input.expression}
            onChange={(expression) => setInput(input.id, { expression })}
            previewPayload={previewPayload}
          />
        </Stack>
      ))}
    </Stack>
  );
}

function CheckboxSet({
  legend,
  options,
  selected,
  onChange,
  disabled = false,
}: Readonly<{
  legend: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
  disabled?: boolean;
}>) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-foreground">{legend}</legend>
      <div className="grid gap-2 md:grid-cols-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              disabled={disabled}
              onChange={() => onChange(toggleStringSelection(selected, option))}
              className="h-4 w-4 rounded border-border accent-accent"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function DryRunFixtureSummary({
  model,
  flow,
}: Readonly<{ model: CatalogProviderProfileAuthoringModel; flow: string }>) {
  const fixture = selectedDryRunFixture(model, flow);
  if (!fixture) {
    return (
      <p>
        {t(
          "catalog.features.sourceObservations.ui.integrationManagementPage.no.fixture.template.is.available.for.this.flow",
        )}
      </p>
    );
  }

  return (
    <KeyValueList
      density="compact"
      variant="plain"
      items={[
        { key: "Payload file", value: fixture.payloadFile },
        { key: "Expected status", value: fixture.expectedStatus },
        { key: "Sample payload", value: fixture.samplePayloadAvailable ? "Available" : "Missing" },
        { key: "Expected hash evidence", value: String(fixture.expectedHashEvidencePaths.length) },
        { key: "Expected merge evidence", value: String(fixture.expectedMergeEvidencePaths.length) },
        { key: "Expected commands", value: String(fixture.expectedPromotionCommands.length) },
      ]}
    />
  );
}

function DryRunSafeOverrideEditor({
  model,
  flow,
  overrides,
  onChange,
}: Readonly<{
  model: CatalogProviderProfileAuthoringModel;
  flow: string;
  overrides: DryRunSafeOverrides;
  onChange: (overrides: DryRunSafeOverrides) => void;
}>) {
  const setOverride = (patch: Partial<DryRunSafeOverrides>) => onChange({ ...overrides, ...patch });
  const sampleFieldItems = dryRunSampleFieldOverrideItems(model, flow);
  const setSampleFieldOverride = (key: string, value: string) =>
    setOverride({ sampleFields: { ...overrides.sampleFields, [key]: value } });

  return (
    <Stack gap={2}>
      <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.safe.payload.overrides")}</h3>
      <Inline gap={2}>
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.override.name")}
          value={overrides.name}
          onChange={(event) => setOverride({ name: event.currentTarget.value })}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.override.language")}
          value={overrides.language}
          onChange={(event) => setOverride({ language: event.currentTarget.value })}
        />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.integrationManagementPage.override.source.updated.at")}
          value={overrides.sourceUpdatedAt}
          onChange={(event) => setOverride({ sourceUpdatedAt: event.currentTarget.value })}
        />
      </Inline>
      {sampleFieldItems.length > 0 ? (
        <Stack gap={2}>
          <h4>{t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.sample.fields")}</h4>
          <Inline gap={2}>
            {sampleFieldItems.map((item) => (
              <TextInput
                key={item.key}
                label={t("catalog.features.sourceObservations.ui.integrationManagementPage.override.value", {
                  value: String(item.label),
                })}
                value={overrides.sampleFields[item.key] ?? ""}
                placeholder={String(item.value)}
                onChange={(event) => setSampleFieldOverride(item.key, event.currentTarget.value)}
              />
            ))}
          </Inline>
        </Stack>
      ) : null}
    </Stack>
  );
}

function ProfileDryRunResultPanels({
  result,
  flow,
}: Readonly<{ result: CatalogProviderProfileDryRunResult; flow: string }>) {
  const diagnosticGroups = dryRunDiagnosticGroups(result.diagnostics, flow);
  const redactionSummary = dryRunRedactionSummary(result);

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.dry.run.summary")}</h3>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            { key: "Status", value: result.status },
            { key: "External key", value: result.observation?.externalKey ?? "None" },
            { key: "Source hash", value: result.observation?.sourceRecordHash ?? "None" },
            { key: "Normalized kind", value: result.observation?.normalized.kind ?? "None" },
            { key: "Redacted payload", value: summarizeJsonValue(result.redactedPayload) },
            { key: "Diagnostics", value: String(result.diagnostics.length) },
            { key: "Fixture flow", value: flow },
          ]}
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostic.groups")}</h3>
        <DataTable
          rows={diagnosticGroups}
          columns={dryRunDiagnosticGroupColumns}
          getRowId={(row, index) => `${row.path}:${index}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.diagnostic.groups")}
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostics")}</h3>
        <DataTable
          rows={result.diagnostics}
          columns={dryRunDiagnosticColumns}
          getRowId={(row, index) => `${row.path}:${index}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.diagnostics")}
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.redaction.summary")}</h3>
        <KeyValueList density="compact" variant="plain" items={redactionSummary} />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.mapping.evidence")}</h3>
        <DataTable
          rows={[...result.hashMaterial, ...result.mergeCandidateEvidence]}
          columns={dryRunEvidenceColumns}
          getRowId={(row) => row.path}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.mapping.evidence")}
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.external.references")}</h3>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            {
              key: "Catalog item references",
              value: summarizeJsonValue(result.externalReferences.catalogItemReferences),
            },
            {
              key: "Product references",
              value: summarizeJsonValue(result.externalReferences.productReferences),
            },
            {
              key: "Selected options",
              value: summarizeJsonValue(result.selectedOptions),
            },
          ]}
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.duplicate.prevention")}</h3>
        <KeyValueList
          density="compact"
          variant="plain"
          items={[
            {
              key: "Ambiguous candidates",
              value: duplicatePreventionPolicyLabel(result.duplicatePreventionPolicy.ambiguousCandidatePolicy),
            },
            {
              key: "Replay policy",
              value: duplicatePreventionPolicyLabel(result.duplicatePreventionPolicy.replayPolicy),
            },
            {
              key: "Exact external references first",
              value: result.duplicatePreventionPolicy.exactExternalCatalogItemReferencesFirst ? "Yes" : "No",
            },
            {
              key: "Candidate preview",
              value: duplicatePreventionCandidatePreviewLabel(result.duplicatePreventionCandidatePreview),
            },
            {
              key: "Candidate IDs",
              value: result.duplicatePreventionCandidatePreview?.candidateCatalogItemIds.join(", ") || "None",
            },
          ]}
        />
        <DataTable
          rows={result.duplicatePreventionRules}
          columns={dryRunDuplicatePreventionColumns}
          getRowId={(row) => row.ruleKey}
          emptyTitle={t(
            "catalog.features.sourceObservations.ui.integrationManagementPage.no.duplicate.prevention.decisions",
          )}
          density="compact"
        />
      </Stack>

      <Stack gap={2}>
        <h3>{t("catalog.features.sourceObservations.ui.integrationManagementPage.promotion.command.plan")}</h3>
        <DataTable
          rows={result.promotionCommandPlan.commands}
          columns={dryRunPromotionCommandColumns}
          getRowId={(row, index) => `${row.commandName}:${index}`}
          emptyTitle={t("catalog.features.sourceObservations.ui.integrationManagementPage.no.promotion.commands")}
          density="compact"
        />
      </Stack>
    </Stack>
  );
}

const activationReadinessColumns: DataColumn<
  CatalogProviderProfileAuthoringModel["activationReadiness"]["checks"][number]
>[] = [
  {
    key: "status",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.status"),
    cell: (row) => (
      <StatusPill tone={row.status === "passed" ? "success" : "danger"}>
        {row.status === "passed" ? "Passed" : "Blocked"}
      </StatusPill>
    ),
  },
  {
    key: "check",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.check"),
    cell: (row) => row.checkKey,
  },
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
    cell: (row) => row.path,
  },
  {
    key: "detail",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.detail"),
    cell: (row) => row.diagnosticText,
  },
];

const semanticDiffColumns: DataColumn<CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]>[] = [
  {
    key: "change",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.change"),
    cell: (row) => (
      <Stack gap={1}>
        <span>{row.label}</span>
        <Inline gap={1}>
          <StatusPill tone={row.changed ? "warning" : "success"}>{row.changed ? "Changed" : "Unchanged"}</StatusPill>
          <StatusPill tone={semanticDiffSeverityTone(row.severity)}>{row.severity}</StatusPill>
        </Inline>
      </Stack>
    ),
  },
  {
    key: "impact",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.activation.impact"),
    cell: (row) => row.activationImpact,
  },
  {
    key: "candidate",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.candidate"),
    cell: (row) => summarizeDiffValue(row.candidate),
  },
  {
    key: "active",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.active"),
    cell: (row) => summarizeDiffValue(row.active),
  },
];

function semanticDiffSeverityTone(
  severity: CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]["severity"],
) {
  switch (severity) {
    case "error":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "neutral";
  }
}

const profileValidationColumns: DataColumn<CatalogProviderProfileVersionReview["validation"]["diagnostics"][number]>[] =
  [
    {
      key: "path",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
      cell: (row) => row.path,
    },
    {
      key: "severity",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.severity"),
      cell: (row) => <StatusPill tone={row.severity === "error" ? "danger" : "warning"}>{row.severity}</StatusPill>,
    },
    {
      key: "detail",
      header: t("catalog.features.sourceObservations.ui.integrationManagementPage.detail"),
      cell: (row) => row.diagnosticText,
    },
  ];

const integrationFailureGroupColumns: DataColumn<IntegrationFailureGroup>[] = [
  {
    key: "reason",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.reason"),
    cell: (row) => row.reason,
  },
  {
    key: "count",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.failures"),
    cell: (row) => String(row.count),
  },
  {
    key: "examples",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.example.scopes"),
    cell: (row) =>
      row.examples.length > 0 ? (
        <Inline gap={2}>
          {row.examples.map((example) => (
            <LinkButton key={`${row.reason}-${example.label}`} href={example.href} size="sm" tone="secondary">
              {example.label}
            </LinkButton>
          ))}
        </Inline>
      ) : (
        "No example scopes"
      ),
  },
];

const dryRunDiagnosticColumns: DataColumn<CatalogProviderProfileDryRunResult["diagnostics"][number]>[] = [
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
    cell: (row) => row.path,
  },
  {
    key: "code",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.code"),
    cell: (row) => row.code,
  },
  {
    key: "detail",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.detail"),
    cell: (row) => row.diagnosticText,
  },
];

const dryRunDiagnosticGroupColumns: DataColumn<ReturnType<typeof dryRunDiagnosticGroups>[number]>[] = [
  {
    key: "flow",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.fixture.flow.2"),
    cell: (row) => row.flow,
  },
  {
    key: "section",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.profile.section"),
    cell: (row) => row.section,
  },
  {
    key: "count",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.diagnostics"),
    cell: (row) => String(row.count),
  },
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.example.path"),
    cell: (row) => row.path,
  },
];

const dryRunEvidenceColumns: DataColumn<CatalogProviderProfileDryRunResult["hashMaterial"][number]>[] = [
  {
    key: "path",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.path"),
    cell: (row) => row.path,
  },
  {
    key: "owner",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.owner"),
    cell: (row) => row.owner,
  },
  {
    key: "uses",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.uses"),
    cell: (row) => row.uses.join(", "),
  },
  {
    key: "redaction",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.redaction"),
    cell: (row) => row.redaction,
  },
  {
    key: "value",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.value"),
    cell: (row) => summarizeJsonValue(row.value),
  },
];

const dryRunDuplicatePreventionColumns: DataColumn<
  CatalogProviderProfileDryRunResult["duplicatePreventionRules"][number]
>[] = [
  {
    key: "rule",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.rule"),
    cell: (row) => row.ruleKey,
  },
  {
    key: "kind",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.kind"),
    cell: (row) => row.ruleKind,
  },
  {
    key: "policy",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.policy"),
    cell: (row) => row.candidatePolicy,
  },
  {
    key: "evidence",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.evidence"),
    cell: (row) => String(row.evidence.length),
  },
];

const dryRunPromotionCommandColumns: DataColumn<
  CatalogProviderProfileDryRunResult["promotionCommandPlan"]["commands"][number]
>[] = [
  {
    key: "command",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.command"),
    cell: (row) => row.commandName,
  },
  {
    key: "inputs",
    header: t("catalog.features.sourceObservations.ui.integrationManagementPage.inputs"),
    cell: (row) => String(row.inputs.length),
  },
];

function buildColumns(actions: IntegrationRowActions): DataColumn<SourceObservationIntegrationScope>[] {
  return [
    {
      key: "provider",
      header: t("catalog.features.sourceObservations.ui.integrations.provider"),
      cell: (row) => row.provider_key,
    },
    {
      key: "language",
      header: t("catalog.features.sourceObservations.ui.list.language"),
      cell: (row) => formatLanguageCodeLabel(row.language_code),
    },
    {
      key: "expansion",
      header: t("catalog.features.sourceObservations.ui.list.expansion"),
      cell: (row) => row.expansion_name || row.expansion_id,
    },
    {
      key: "series",
      header: t("catalog.features.sourceObservations.ui.integrations.series"),
      cell: (row) => row.series_name || row.series_id || row.product_line_name || "",
    },
    {
      key: "observed",
      header: t("catalog.features.sourceObservations.ui.integrations.needs.review"),
      cell: (row) => formatCount(reviewableObservationCount(row)),
    },
    {
      key: "promoted",
      header: t("catalog.features.sourceObservations.ui.integrations.promoted"),
      cell: (row) => formatCount(row.promoted_observations),
    },
    {
      key: "rejected",
      header: t("catalog.features.sourceObservations.ui.integrations.rejected"),
      cell: (row) => formatCount(row.rejected_observations),
    },
    {
      key: "latest",
      header: t("catalog.features.sourceObservations.ui.integrations.last.observed"),
      cell: (row) => formatDateTime(row.latest_observed_at),
    },
    {
      key: "review",
      header: "",
      cell: (row) => (
        <Inline gap={2} align="end">
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="badgeCheck"
            disabled={!actions.canManage || actions.busy || reviewableObservationCount(row) === 0}
            onClick={() => actions.onPromoteAll(rowPromotionScope(row))}
          >
            {t("catalog.features.sourceObservations.ui.integrations.promote.all")}
          </Button>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="refreshCcw"
            disabled={!actions.canManage || actions.busy}
            onClick={() => actions.onResync(rowIntegrationScope(row))}
          >
            {t("catalog.features.sourceObservations.ui.integrations.resync.set")}
          </Button>
          <Button
            size="sm"
            tone="secondary"
            leadingIcon="badgeCheck"
            disabled={!actions.canManage || actions.busy || row.promoted_observations === 0}
            onClick={() => actions.onReapply(rowPromotionScope(row))}
          >
            {t("catalog.features.sourceObservations.ui.integrations.sync.promoted")}
          </Button>
          <LinkButton href={sourceObservationScopeHref(row)} size="sm" tone="secondary">
            {t("catalog.features.sourceObservations.ui.integrations.review")}
          </LinkButton>
        </Inline>
      ),
    },
  ];
}

function rowPromotionScope(scope: SourceObservationIntegrationScope): SourceObservationPromotionScope {
  return {
    provider: scope.provider_key,
    language: scope.language_code,
    setId: scope.expansion_id,
  };
}

function rowIntegrationScope(scope: SourceObservationIntegrationScope): SourceObservationIntegrationJobScope {
  if (scope.provider_key === TCGPLAYER_PROVIDER) {
    return {
      provider: scope.provider_key,
      language: scope.language_code,
      productLineId: scope.product_line_id || undefined,
      setName: scope.expansion_name || scope.expansion_id || undefined,
    };
  }

  return {
    provider: scope.provider_key,
    language: scope.language_code,
    setId: scope.expansion_id,
  };
}

function activeProviderProfile(
  profiles: readonly CatalogProviderProfileVersionReview[],
  providerKey: string,
): CatalogProviderProfileVersionReview | null {
  return profiles.find((profile) => profile.providerKey === providerKey && profile.active) ?? null;
}

function integrationFailureGroups(result: SourceObservationIntegrationJobResult): IntegrationFailureGroup[] {
  const groups = new Map<string, { reason: string; count: number; examples: { label: string; href: string }[] }>();
  for (const outcome of result.outcomes) {
    if (outcome.status !== "failed") {
      continue;
    }
    const reason = outcome.reason?.trim() || "Unknown failure";
    const example = [outcome.providerKey, outcome.languageCode, outcome.expansionId].filter(Boolean).join("/");
    const existing = groups.get(reason);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 3) {
        existing.examples.push({ label: example, href: sourceObservationOutcomeHref(outcome) });
      }
    } else {
      groups.set(reason, {
        reason,
        count: 1,
        examples: [{ label: example, href: sourceObservationOutcomeHref(outcome) }],
      });
    }
  }
  return [...groups.values()];
}

function summarizeScopes(scopes: readonly SourceObservationIntegrationScope[]) {
  return scopes.reduce(
    (summary, scope) => ({
      scopes: summary.scopes + 1,
      total: summary.total + scope.total_observations,
      observed: summary.observed + scope.observed_observations,
      changed: summary.changed + scope.changed_observations,
      promoted: summary.promoted + scope.promoted_observations,
    }),
    {
      scopes: 0,
      total: 0,
      observed: 0,
      changed: 0,
      promoted: 0,
    },
  );
}

function reviewableObservationCount(scope: SourceObservationIntegrationScope): number {
  return scope.observed_observations + scope.changed_observations;
}

function toSelectItems(options: readonly SourceObservationIntegrationOption[]): SelectItem[] {
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description ?? undefined,
  }));
}

function selectedSelectItemLabel(options: readonly SelectItem[], value: string): string {
  if (!value) {
    return "Not selected";
  }

  const option = options.find((item) => item.value === value);
  return option ? `${option.label} (${option.value})` : value;
}

function withSelectedFallback(options: readonly SelectItem[], selectedValue: string): SelectItem[] {
  if (!selectedValue || options.some((option) => option.value === selectedValue)) {
    return [...options];
  }

  return [
    {
      label: selectedValue,
      value: selectedValue,
    },
    ...options,
  ];
}

function profileActionIdentity(profile: Pick<CatalogProviderProfileVersionReview, "providerKey" | "profileVersion">) {
  return `${profile.providerKey}:${profile.profileVersion}`;
}

function nextProfileVersion(currentVersion = ""): string {
  const match = currentVersion.match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return new Date().toISOString().slice(0, 10).replaceAll("-", ".");
  }

  return `${match[1]}.${match[2]}.${match[3]}.${match[4] ? Number(match[4]) + 1 : 1}`;
}

function profileEditableJson(profile: CatalogProviderProfileVersionReview | null) {
  if (!profile) {
    return {
      profile: null,
      sourceContract: null,
      fixtures: null,
      compatibilityMode: null,
      retirementPlan: null,
      executableMappingContract: null,
    };
  }

  return {
    profile: profile.profile,
    sourceContract: profile.sourceContract,
    fixtures: profile.fixtures,
    compatibilityMode: profile.compatibilityMode,
    retirementPlan: profile.retirementPlan,
    executableMappingContract: profile.executableMappingContract,
  };
}

function activeProfileFor(
  profile: CatalogProviderProfileVersionReview,
  profiles: readonly CatalogProviderProfileVersionReview[],
): CatalogProviderProfileVersionReview | null {
  return profiles.find((candidate) => candidate.providerKey === profile.providerKey && candidate.active) ?? null;
}

function profileComparisonItems(
  candidate: CatalogProviderProfileVersionReview,
  active: CatalogProviderProfileVersionReview | null,
) {
  return [
    { key: "Provider", value: candidate.displayName },
    { key: "Active version", value: active?.profileVersion ?? "None" },
    { key: "Candidate version", value: candidate.profileVersion },
    { key: "Active lifecycle", value: active?.lifecycle ?? "None" },
    { key: "Candidate lifecycle", value: candidate.lifecycle },
    { key: "Active output", value: active?.mappingOutputKind ?? "None" },
    { key: "Candidate output", value: candidate.mappingOutputKind },
  ];
}

function profileBasicsForm(profile: CatalogProviderProfileVersionReview): ProfileBasicsForm {
  const retirementPlan = profile.retirementPlan;
  const retirementPlanObject = isRecord(retirementPlan) ? retirementPlan : null;
  const trackingIssue =
    typeof retirementPlanObject?.trackingIssue === "number" ? String(retirementPlanObject.trackingIssue) : "";
  const diagnosticText =
    typeof retirementPlanObject?.diagnosticText === "string" ? retirementPlanObject.diagnosticText : "";
  const optionQueries =
    isRecord(profile.profile) && Array.isArray(profile.profile.optionQueries)
      ? profile.profile.optionQueries.map(profileOptionQueryForm)
      : [];

  return {
    displayName: profile.displayName,
    lifecycle: profile.lifecycle === "test" ? "test" : "draft",
    status: profile.status === "active" ? "active" : "planned",
    compatibilityMode:
      profile.compatibilityMode === "transitional-static-profile"
        ? "transitional-static-profile"
        : "executable-mapping-contract",
    capabilities: [...profile.capabilities],
    supportedScopes: [...profile.supportedScopes],
    languageOptionsText: profile.languageOptions.join("\n"),
    sourceContract: {
      owner: profile.sourceContract.owner,
      repository: profile.sourceContract.repository ?? "",
      commit: profile.sourceContract.commit ?? "",
      documentPath: profile.sourceContract.documentPath,
      fixtureSetVersion: profile.sourceContract.fixtureSetVersion,
    },
    retirementPlan: {
      enabled: Boolean(retirementPlanObject),
      trackingIssueText: trackingIssue,
      diagnosticText,
    },
    optionQueries,
    connector: profileConnectorForm(isRecord(profile.profile) ? profile.profile.connector : null),
    fixtures: {
      fixtureRoot: profile.fixtures.fixtureRoot,
      coveredFlows: [...profile.fixtures.coveredFlows],
    },
    normalizedObservation: profileNormalizedObservationForm(profile),
    externalReferences: profileExternalReferencesForm(profile),
    referenceHierarchy: profileReferenceHierarchyForm(profile),
    duplicatePrevention: profileDuplicatePreventionForm(profile),
    promotionPlan: profilePromotionPlanForm(profile),
  };
}

function profileBasicsSaveDisabled(
  profile: CatalogProviderProfileVersionReview | null,
  form: ProfileBasicsForm | null,
  authoringModel: CatalogProviderProfileAuthoringModel | null = null,
): boolean {
  if (!profile || !form || !profileLifecycleEditable(profile)) {
    return true;
  }

  if (
    !form.displayName.trim() ||
    form.capabilities.length === 0 ||
    !form.sourceContract.owner.trim() ||
    !form.sourceContract.documentPath.trim() ||
    !form.sourceContract.fixtureSetVersion.trim()
  ) {
    return true;
  }

  return (
    (form.retirementPlan.enabled &&
      (!positiveIntegerText(form.retirementPlan.trackingIssueText) || !form.retirementPlan.diagnosticText.trim())) ||
    validateOptionQueryForms(form.optionQueries).length > 0 ||
    validateConnectorForm(form.connector).length > 0 ||
    validateNormalizedObservationForm(form.normalizedObservation).length > 0 ||
    validateExternalReferencesForm(form.externalReferences, authoringModel?.selectedOptionSchema ?? null).length > 0 ||
    validateReferenceHierarchyForm(form.referenceHierarchy).length > 0 ||
    validateDuplicatePreventionForm(form.duplicatePrevention).length > 0 ||
    validatePromotionPlanForm(form.promotionPlan, form).length > 0 ||
    !form.fixtures.fixtureRoot.trim()
  );
}

function profileLifecycleEditable(profile: CatalogProviderProfileVersionReview): boolean {
  return !profile.active && (profile.lifecycle === "draft" || profile.lifecycle === "test");
}

function parseListInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNumberListInput(value: string): number[] {
  return parseListInput(value)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry));
}

function nullableTrimmedValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function profileNormalizedObservationForm(
  profile: CatalogProviderProfileVersionReview,
): ProfileNormalizedObservationForm {
  const profileRecord = isRecord(profile.profile) ? profile.profile : {};
  const profileMapping = isRecord(profileRecord.normalizedObservationMapping)
    ? { ...profileRecord.normalizedObservationMapping }
    : {};
  const contractRoot = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : {};
  const normalizedObservation = isRecord(contractRoot.normalizedObservation) ? contractRoot.normalizedObservation : {};
  const fields = isRecord(normalizedObservation.fields) ? normalizedObservation.fields : {};
  const outputKind = normalizedOutputKindValue(
    normalizedObservation.outputKind,
    profileMapping.kind,
    profile.mappingOutputKind,
  );

  return {
    outputKind,
    profileMapping,
    languageCode: mappingExpressionFromUnknown(
      normalizedObservation.languageCode,
      defaultPathExpression("languageCode", "catalog-truth", ["normalized-observation", "hash-material"]),
    ),
    fields: Object.entries(fields).map(([fieldKey, expression], index) => ({
      id: `field-${fieldKey || index}`,
      fieldKey,
      expression: mappingExpressionFromUnknown(
        expression,
        defaultPathExpression(fieldKey, "catalog-truth", ["normalized-observation"]),
      ),
    })),
    hashMaterial: expressionListForm(normalizedObservation.hashMaterial, "hash", ["hash-material"]),
    mergeIdentity: expressionListForm(normalizedObservation.mergeIdentity, "merge", ["merge-identity"]),
  };
}

function normalizedOutputKindValue(...values: readonly unknown[]): "pokemon-card" | "provider-product" {
  return values.some((value) => value === "pokemon-card") ? "pokemon-card" : "provider-product";
}

function expressionListForm(
  value: unknown,
  prefix: string,
  uses: MappingExpressionValue["uses"],
): readonly ProfileExpressionListItemForm[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((expression, index) => ({
    id: `${prefix}-${index}`,
    expression: mappingExpressionFromUnknown(expression, defaultPathExpression("", "catalog-truth", uses)),
  }));
}

function mappingExpressionFromUnknown(value: unknown, fallback: MappingExpressionValue): MappingExpressionValue {
  if (!isRecord(value) || !isRecord(value.selector)) {
    return fallback;
  }
  return value as unknown as MappingExpressionValue;
}

function defaultPathExpression(
  path: string,
  owner: MappingExpressionValue["owner"],
  uses: MappingExpressionValue["uses"],
): MappingExpressionValue {
  return {
    ...defaultExpression(),
    selector: { kind: "path", path, required: true, nullPolicy: "diagnostic" },
    owner,
    uses,
  };
}

function emptyExpressionFieldForm(): ProfileExpressionFieldForm {
  return {
    id: newFormRowId("field"),
    fieldKey: "",
    expression: defaultPathExpression("", "catalog-truth", ["normalized-observation"]),
  };
}

function emptyExpressionListItemForm(): ProfileExpressionListItemForm {
  return {
    id: newFormRowId("expression"),
    expression: defaultPathExpression("", "catalog-truth", ["hash-material"]),
  };
}

function normalizedObservationMappingFormToCommand(
  form: ProfileNormalizedObservationForm,
): CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationMapping"] {
  return {
    ...form.profileMapping,
    kind: form.outputKind,
  } as CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationMapping"];
}

function normalizedObservationContractFormToCommand(
  form: ProfileNormalizedObservationForm,
): CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationContract"] {
  return {
    outputKind: form.outputKind,
    languageCode: form.languageCode,
    fields: Object.fromEntries(
      form.fields.map((field) => [field.fieldKey.trim(), field.expression]).filter(([fieldKey]) => fieldKey),
    ),
    hashMaterial: form.hashMaterial.map((item) => item.expression),
    mergeIdentity: form.mergeIdentity.map((item) => item.expression),
  } as CatalogProviderProfileNormalizedObservationUpdateCommand["normalizedObservationContract"];
}

function validateNormalizedObservationForm(form: ProfileNormalizedObservationForm): string[] {
  const diagnostics: string[] = [];
  const seenFields = new Set<string>();

  diagnostics.push(...prefixedExpressionDiagnostics("Language expression", form.languageCode));

  for (const field of form.fields) {
    const fieldKey = field.fieldKey.trim();
    const label = fieldKey || "Normalized field";
    if (!fieldKey) {
      diagnostics.push("Normalized field key is required.");
    }
    if (seenFields.has(fieldKey)) {
      diagnostics.push(`${label}: normalized field keys must be unique.`);
    }
    seenFields.add(fieldKey);
    diagnostics.push(...prefixedExpressionDiagnostics(label, field.expression));
    diagnostics.push(...unsafeEvidenceDiagnostics(label, field.expression, "normalized field"));
  }

  if (form.hashMaterial.length === 0) {
    diagnostics.push("Hash material needs at least one expression.");
  }
  form.hashMaterial.forEach((item, index) => {
    const label = `Hash material ${index + 1}`;
    diagnostics.push(...prefixedExpressionDiagnostics(label, item.expression));
    diagnostics.push(...unsafeEvidenceDiagnostics(label, item.expression, "hash material"));
  });

  if (form.mergeIdentity.length === 0) {
    diagnostics.push("Merge identity needs at least one expression.");
  }
  form.mergeIdentity.forEach((item, index) => {
    const label = `Merge identity ${index + 1}`;
    diagnostics.push(...prefixedExpressionDiagnostics(label, item.expression));
    diagnostics.push(...unsafeEvidenceDiagnostics(label, item.expression, "merge identity"));
  });

  return diagnostics;
}

function prefixedExpressionDiagnostics(label: string, expression: MappingExpressionValue): string[] {
  return validateMappingExpression(expression).map((diagnostic) => `${label}: ${diagnostic}`);
}

function unsafeEvidenceDiagnostics(
  label: string,
  expression: MappingExpressionValue,
  surface: "normalized field" | "hash material" | "merge identity",
): string[] {
  const diagnostics: string[] = [];
  for (const candidate of expressionTree(expression)) {
    const selectorPath = selectorEvidencePath(candidate.selector).toLowerCase();
    const unsafePath = [
      "price",
      "pricing",
      "inventory",
      "seller",
      "listing",
      "order",
      "message",
      "auth",
      "cookie",
    ].some((token) => selectorPath.includes(token));
    const unsafeOwner =
      candidate.owner === "pricing-signal" ||
      candidate.owner === "inventory-signal" ||
      candidate.owner === "operations";
    const unsafeRedaction = candidate.redaction !== "none";
    const drivesCatalogTruth = candidate.uses.includes("normalized-observation") || candidate.owner === "catalog-truth";
    const drivesHash = candidate.uses.includes("hash-material") || surface === "hash material";

    if ((unsafeOwner || unsafeRedaction || unsafePath) && (drivesCatalogTruth || drivesHash)) {
      diagnostics.push(
        `${label}: ${surface} cannot use secret, pricing, inventory, operations, seller, listing, order, or message evidence.`,
      );
      break;
    }
  }
  return diagnostics;
}

function expressionTree(expression: MappingExpressionValue): readonly MappingExpressionValue[] {
  const nested: MappingExpressionValue[] = [expression];
  const selector = expression.selector;
  if (selector.kind === "template") {
    nested.push(...Object.values(selector.values).flatMap((value) => expressionTree(value)));
  }
  if (selector.kind === "array") {
    nested.push(...selector.items.flatMap((value) => expressionTree(value)));
  }
  if (selector.kind === "object") {
    nested.push(...Object.values(selector.fields).flatMap((value) => expressionTree(value)));
  }
  if (selector.kind === "array-map") {
    nested.push(...expressionTree(selector.item));
  }
  return nested;
}

function selectorEvidencePath(selector: MappingExpressionValue["selector"]): string {
  if (selector.kind === "path" || selector.kind === "array-map") {
    return selector.path;
  }
  if (selector.kind === "template") {
    return selector.template;
  }
  if (selector.kind === "named-runtime-selector") {
    return `${selector.functionKey} ${selector.reason}`;
  }
  return "";
}

function profileExternalReferencesForm(profile: CatalogProviderProfileVersionReview): ProfileExternalReferencesForm {
  const profileRecord = isRecord(profile.profile) ? profile.profile : {};
  const contractRoot = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : {};
  const externalReferences = Array.isArray(contractRoot.externalReferences) ? contractRoot.externalReferences : [];
  return {
    extractionRules: isRecord(profileRecord.externalReferenceExtractionRules)
      ? { ...profileRecord.externalReferenceExtractionRules }
      : {},
    contracts: externalReferences.map(externalReferenceForm),
    selectedOptionMapping: selectedOptionMappingForm(profileRecord.selectedOptionMapping),
  };
}

function externalReferenceForm(value: unknown, index: number): ProfileExternalReferenceForm {
  const reference = isRecord(value) ? value : {};
  const target = reference.target === "product-reference" ? "product-reference" : "catalog-item-reference";
  return {
    id: `external-reference-${index}`,
    target,
    providerKey: stringValue(reference.providerKey),
    externalKeyPrefix: stringValue(reference.externalKeyPrefix),
    source: mappingExpressionFromUnknown(
      reference.source,
      defaultPathExpression("", "external-reference", ["external-reference"]),
    ),
    ambiguityPolicy: externalReferenceAmbiguityPolicyValue(reference.ambiguityPolicy),
    selectedOptions: target === "product-reference" ? externalSelectedOptionsForm(reference.selectedOptions) : null,
  };
}

function externalSelectedOptionsForm(value: unknown): ProfileExternalSelectedOptionsForm {
  const selectedOptions = isRecord(value) ? value : {};
  const dimensions = Array.isArray(selectedOptions.dimensions) ? selectedOptions.dimensions : [];
  return {
    missingOrUnknownOptionPolicy:
      selectedOptions.missingOrUnknownOptionPolicy === "diagnostic" ? "diagnostic" : "leave-unmapped-review-evidence",
    dimensions: dimensions.map(externalSelectedOptionDimensionForm),
  };
}

function externalSelectedOptionDimensionForm(
  value: unknown,
  index: number,
): ProfileExternalSelectedOptionDimensionForm {
  const dimension = isRecord(value) ? value : {};
  return {
    id: `external-option-dimension-${index}`,
    dimensionKey: stringValue(dimension.dimensionKey),
    providerValue: mappingExpressionFromUnknown(
      dimension.providerValue,
      defaultPathExpression("", "external-reference", ["selected-option"]),
    ),
    optionLookupTableKey: stringValue(dimension.optionLookupTableKey),
    required: dimension.required === true,
  };
}

function selectedOptionMappingForm(value: unknown): ProfileSelectedOptionMappingForm | null {
  if (!isRecord(value)) {
    return null;
  }
  const productReferenceRule = isRecord(value.productReferenceRule) ? value.productReferenceRule : {};
  const dimensions = Array.isArray(value.dimensions) ? value.dimensions : [];
  return {
    source: stringValue(value.source) || "tcgplayer-sku-condition-variant-language",
    providerKey: stringValue(productReferenceRule.providerKey) || "tcgplayer",
    externalKeyPrefix: stringValue(productReferenceRule.externalKeyPrefix) || "sku:",
    requiredSourceKeysText: arrayText(productReferenceRule.requiredSourceKeys),
    missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
    dimensions: dimensions.map(selectedOptionMappingDimensionForm),
  };
}

function selectedOptionMappingDimensionForm(value: unknown, index: number): ProfileSelectedOptionMappingDimensionForm {
  const dimension = isRecord(value) ? value : {};
  const providerValue = isRecord(dimension.providerValue) ? dimension.providerValue : {};
  return {
    id: `selected-option-mapping-${index}`,
    dimensionKey: stringValue(dimension.dimensionKey),
    providerValueSource: providerValue.source === "payload" ? "payload" : "record",
    providerValuePath: stringValue(providerValue.path),
    required: dimension.required === true,
    optionAliasesText: selectedOptionAliasesText(dimension.optionAliases),
    valueMappingsText: selectedOptionValueMappingsText(dimension.valueMappings),
  };
}

function emptyExternalReferenceForm(): ProfileExternalReferenceForm {
  return {
    id: newFormRowId("external-reference"),
    target: "catalog-item-reference",
    providerKey: "",
    externalKeyPrefix: "",
    source: defaultPathExpression("", "external-reference", ["external-reference"]),
    ambiguityPolicy: "review-evidence",
    selectedOptions: null,
  };
}

function emptyExternalSelectedOptionsForm(): ProfileExternalSelectedOptionsForm {
  return {
    missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
    dimensions: [emptyExternalSelectedOptionDimensionForm()],
  };
}

function emptyExternalSelectedOptionDimensionForm(): ProfileExternalSelectedOptionDimensionForm {
  return {
    id: newFormRowId("external-option-dimension"),
    dimensionKey: "",
    providerValue: defaultPathExpression("", "external-reference", ["selected-option"]),
    optionLookupTableKey: "",
    required: true,
  };
}

function emptySelectedOptionMappingForm(): ProfileSelectedOptionMappingForm {
  return {
    source: "tcgplayer-sku-condition-variant-language",
    providerKey: "tcgplayer",
    externalKeyPrefix: "sku:",
    requiredSourceKeysText: "sku\ncondition\nvariant\nlanguage",
    missingOrUnknownOptionPolicy: "leave-unmapped-review-evidence",
    dimensions: [emptySelectedOptionMappingDimensionForm()],
  };
}

function emptySelectedOptionMappingDimensionForm(): ProfileSelectedOptionMappingDimensionForm {
  return {
    id: newFormRowId("selected-option-mapping"),
    dimensionKey: "",
    providerValueSource: "record",
    providerValuePath: "",
    required: true,
    optionAliasesText: "",
    valueMappingsText: "",
  };
}

function externalReferenceExtractionRulesFormToCommand(
  form: ProfileExternalReferencesForm,
): CatalogProviderProfileExternalReferencesUpdateCommand["externalReferenceExtractionRules"] {
  return form.extractionRules as CatalogProviderProfileExternalReferencesUpdateCommand["externalReferenceExtractionRules"];
}

function externalReferenceContractsFormToCommand(
  form: ProfileExternalReferencesForm,
): CatalogProviderProfileExternalReferencesUpdateCommand["externalReferenceContracts"] {
  return form.contracts.map((contract) => ({
    target: contract.target,
    providerKey: contract.providerKey.trim(),
    externalKeyPrefix: contract.externalKeyPrefix.trim(),
    source: contract.source,
    ...(contract.target === "product-reference" && contract.selectedOptions
      ? { selectedOptions: externalSelectedOptionsFormToCommand(contract.selectedOptions) }
      : {}),
    ambiguityPolicy: contract.ambiguityPolicy,
  })) as CatalogProviderProfileExternalReferencesUpdateCommand["externalReferenceContracts"];
}

function externalSelectedOptionsFormToCommand(form: ProfileExternalSelectedOptionsForm) {
  return {
    dimensions: form.dimensions.map((dimension) => ({
      dimensionKey: dimension.dimensionKey.trim(),
      providerValue: dimension.providerValue,
      optionLookupTableKey: dimension.optionLookupTableKey.trim(),
      required: dimension.required,
    })),
    missingOrUnknownOptionPolicy: form.missingOrUnknownOptionPolicy,
  };
}

function selectedOptionMappingFormToCommand(
  form: ProfileSelectedOptionMappingForm | null,
): CatalogProviderProfileSelectedOptionsUpdateCommand["selectedOptionMapping"] {
  if (!form) {
    return null;
  }
  return {
    source: form.source,
    dimensions: form.dimensions.map(selectedOptionMappingDimensionFormToCommand),
    productReferenceRule: {
      providerKey: form.providerKey.trim(),
      externalKeyPrefix: form.externalKeyPrefix.trim(),
      requiredSourceKeys: parseListInput(form.requiredSourceKeysText),
      missingOrUnknownOptionPolicy: form.missingOrUnknownOptionPolicy,
    },
  } as CatalogProviderProfileSelectedOptionsUpdateCommand["selectedOptionMapping"];
}

function selectedOptionMappingDimensionFormToCommand(dimension: ProfileSelectedOptionMappingDimensionForm) {
  const command: Record<string, unknown> = {
    dimensionKey: dimension.dimensionKey.trim(),
    providerValue: {
      source: dimension.providerValueSource,
      path: dimension.providerValuePath.trim(),
    },
    required: dimension.required,
    unknownPolicy: "review-evidence",
  };
  const optionAliases = selectedOptionAliasesObject(dimension.optionAliasesText);
  const valueMappings = selectedOptionValueMappingsObject(dimension.valueMappingsText);
  if (optionAliases.length > 0) {
    command.optionAliases = optionAliases;
  }
  if (valueMappings.length > 0) {
    command.valueMappings = valueMappings;
  }
  return command;
}

function validateExternalReferencesForm(
  form: ProfileExternalReferencesForm,
  selectedOptionSchema: CatalogProviderProfileAuthoringModel["selectedOptionSchema"] = null,
): string[] {
  const diagnostics: string[] = [];
  form.contracts.forEach((contract, index) => {
    const label = `${contract.target === "product-reference" ? "Product reference" : "Catalog Item reference"} ${index + 1}`;
    if (!contract.providerKey.trim() || !contract.externalKeyPrefix.trim()) {
      diagnostics.push(`${label}: provider key and external key prefix are required.`);
    }
    diagnostics.push(...prefixedExpressionDiagnostics(`${label} source`, contract.source));
    if (contract.target === "product-reference") {
      if (!contract.selectedOptions || contract.selectedOptions.dimensions.length === 0) {
        diagnostics.push(`${label}: product references require selected option dimensions.`);
      }
      contract.selectedOptions?.dimensions.forEach((dimension, dimensionIndex) => {
        const dimensionLabel = `${label} selected option ${dimensionIndex + 1}`;
        if (!dimension.dimensionKey.trim() || !dimension.optionLookupTableKey.trim()) {
          diagnostics.push(`${dimensionLabel}: dimension key and option lookup table key are required.`);
        }
        diagnostics.push(
          ...selectedOptionSchemaDiagnostics(dimensionLabel, dimension.dimensionKey, "", selectedOptionSchema),
        );
        diagnostics.push(...prefixedExpressionDiagnostics(`${dimensionLabel} value`, dimension.providerValue));
      });
    }
  });

  if (form.selectedOptionMapping) {
    if (!form.selectedOptionMapping.providerKey.trim() || !form.selectedOptionMapping.externalKeyPrefix.trim()) {
      diagnostics.push("Selected option mapping: product reference provider key and prefix are required.");
    }
    if (parseListInput(form.selectedOptionMapping.requiredSourceKeysText).length === 0) {
      diagnostics.push("Selected option mapping: at least one required source key is required.");
    }
    form.selectedOptionMapping.dimensions.forEach((dimension, index) => {
      const label = `Selected option mapping dimension ${index + 1}`;
      if (!dimension.dimensionKey.trim() || !dimension.providerValuePath.trim()) {
        diagnostics.push(`${label}: dimension key and provider value path are required.`);
      }
      diagnostics.push(
        ...selectedOptionSchemaDiagnostics(
          label,
          dimension.dimensionKey,
          dimension.optionAliasesText,
          selectedOptionSchema,
        ),
      );
    });
  }

  return diagnostics;
}

function selectedOptionSchemaDiagnostics(
  label: string,
  dimensionKey: string,
  optionAliasesText: string,
  selectedOptionSchema: CatalogProviderProfileAuthoringModel["selectedOptionSchema"],
): string[] {
  if (!selectedOptionSchema || !dimensionKey.trim()) {
    return [];
  }

  const diagnostics: string[] = [];
  const dimension = selectedOptionSchema.dimensions.find(
    (candidate) => normalizeSelectedOptionKey(candidate.dimensionKey) === normalizeSelectedOptionKey(dimensionKey),
  );
  if (!dimension) {
    return [`${label}: dimension key '${dimensionKey}' does not match an active Catalog dimension.`];
  }
  if (dimension.status !== "active") {
    diagnostics.push(`${label}: Catalog dimension '${dimensionKey}' is ${dimension.status}.`);
  }

  for (const alias of selectedOptionAliasesObject(optionAliasesText)) {
    const optionKey = String(alias.optionKey ?? "").trim();
    if (!optionKey) {
      continue;
    }
    const option = dimension.options.find(
      (candidate) => normalizeSelectedOptionKey(candidate.optionKey) === normalizeSelectedOptionKey(optionKey),
    );
    if (!option) {
      diagnostics.push(`${label}: option alias key '${optionKey}' does not match a Catalog option.`);
    } else if (option.status !== "active") {
      diagnostics.push(`${label}: option alias key '${optionKey}' points at a ${option.status} Catalog option.`);
    }
  }

  return diagnostics;
}

function externalReferenceAmbiguityPolicyValue(value: unknown): "skip-reference" | "diagnostic" | "review-evidence" {
  return value === "skip-reference" || value === "diagnostic" ? value : "review-evidence";
}

function selectedOptionAliasesText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((entry) => {
          const alias = isRecord(entry) ? entry : {};
          return `${stringValue(alias.optionKey)}=${Array.isArray(alias.providerValues) ? alias.providerValues.join(",") : ""}`;
        })
        .join("\n")
    : "";
}

function selectedOptionAliasesObject(value: string): readonly Record<string, unknown>[] {
  return value
    .split(/\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [optionKey, ...providerValueParts] = entry.split("=");
      return {
        optionKey: optionKey.trim(),
        providerValues: providerValueParts
          .join("=")
          .split(",")
          .map((providerValue) => providerValue.trim())
          .filter(Boolean),
      };
    })
    .filter((entry) => entry.optionKey.length > 0 && entry.providerValues.length > 0);
}

function selectedOptionValueMappingsText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((entry) => {
          const mapping = isRecord(entry) ? entry : {};
          return `${String(mapping.from ?? "")}=${stringValue(mapping.value)}`;
        })
        .join("\n")
    : "";
}

function selectedOptionValueMappingsObject(value: string): readonly Record<string, unknown>[] {
  return value
    .split(/\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [from, ...valueParts] = entry.split("=");
      return { from: parseJsonLiteral(from.trim()), value: valueParts.join("=").trim() };
    })
    .filter((entry) => entry.value.length > 0);
}

function parseJsonLiteral(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && value.trim() !== "" ? numberValue : value;
}

function profileReferenceHierarchyForm(profile: CatalogProviderProfileVersionReview): ProfileReferenceHierarchyForm {
  const profileRecord = isRecord(profile.profile) ? profile.profile : {};
  const mapping = isRecord(profileRecord.referenceHierarchyMapping) ? profileRecord.referenceHierarchyMapping : {};
  const providerAttributes = Array.isArray(mapping.providerAttributes) ? mapping.providerAttributes : [];
  const referenceTypes = Array.isArray(mapping.referenceTypes) ? mapping.referenceTypes : [];
  const recordRules = Array.isArray(mapping.referenceRecords) ? mapping.referenceRecords : [];
  const contractRoot = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : {};
  const contracts = Array.isArray(contractRoot.referenceHierarchy) ? contractRoot.referenceHierarchy : [];

  return {
    rawMapping: { ...mapping },
    providerReferenceIdPrefix: stringValue(mapping.providerReferenceIdPrefix),
    targetRecordRuleKey: stringValue(mapping.targetRecordRuleKey),
    providerAttributes: providerAttributes.map(referenceProviderAttributeForm),
    referenceTypes: referenceTypes.map(referenceTypeRuleForm),
    recordRules: recordRules.map(referenceRecordRuleForm),
    contracts: contracts.map(referenceHierarchyContractForm),
  };
}

function referenceProviderAttributeForm(value: unknown, index: number): ProfileReferenceProviderAttributeForm {
  const attribute = isRecord(value) ? value : {};
  return {
    id: `reference-provider-attribute-${index}`,
    typeKey: stringValue(attribute.typeKey),
    providerAttributeKey: stringValue(attribute.providerAttributeKey),
  };
}

function referenceTypeRuleForm(value: unknown, index: number): ProfileReferenceTypeRuleForm {
  const type = isRecord(value) ? value : {};
  return {
    id: `reference-type-rule-${index}`,
    referenceTypeId: stringValue(type.referenceTypeId),
    typeKey: stringValue(type.typeKey),
    name: stringValue(type.name),
    descriptionText: stringValue(type.descriptionText),
    attributeKeysText: arrayText(type.attributeKeys),
  };
}

function referenceRecordRuleForm(value: unknown, index: number): ProfileReferenceRecordRuleForm {
  const rule = isRecord(value) ? value : {};
  const recordId = isRecord(rule.recordId) ? rule.recordId : {};
  return {
    id: `reference-record-rule-${index}`,
    ruleKey: stringValue(rule.ruleKey),
    typeKey: stringValue(rule.typeKey),
    recordIdKind: recordId.kind === "static" ? "static" : "provider",
    staticReferenceRecordId: stringValue(recordId.referenceRecordId),
    providerRecordTypeKey: stringValue(recordId.typeKey),
    providerValuePathsText: arrayText(recordId.providerValuePaths),
    keyRule: referenceValueRuleForm(rule.key),
    nameRule: referenceValueRuleForm(rule.name),
    descriptionRule: referenceValueRuleForm(rule.description),
    attributes: referenceAttributeRuleForms(rule.attributes),
    requiredPathsText: arrayText(rule.requiredPaths),
    relationshipsText: referenceRelationshipsText(rule.relationships),
  };
}

function referenceValueRuleForm(value: unknown): ProfileReferenceValueRuleForm {
  const rule = isRecord(value) ? value : {};
  if (rule.kind === "path") {
    return {
      kind: "path",
      staticValue: "",
      path: stringValue(rule.path),
      template: "",
      templateValuesText: "",
    };
  }
  if (rule.kind === "template") {
    return {
      kind: "template",
      staticValue: "",
      path: "",
      template: stringValue(rule.template),
      templateValuesText: referenceTemplateValuesText(rule.values),
    };
  }
  return {
    kind: "static",
    staticValue: stringValue(rule.value),
    path: "",
    template: "",
    templateValuesText: "",
  };
}

function referenceTemplateValuesText(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return Object.entries(value)
    .map(([key, rule]) => `${key}=${referenceValueRuleInlineText(rule)}`)
    .join("\n");
}

function referenceValueRuleInlineText(value: unknown): string {
  const rule = isRecord(value) ? value : {};
  if (rule.kind === "path") {
    return `path:${stringValue(rule.path)}`;
  }
  return `static:${stringValue(rule.value)}`;
}

function referenceAttributeRuleForms(value: unknown): readonly ProfileReferenceAttributeRuleForm[] {
  return Array.isArray(value) ? value.map((attribute, index) => referenceAttributeRuleForm(attribute, index)) : [];
}

function referenceAttributeRuleForm(value: unknown, index: number): ProfileReferenceAttributeRuleForm {
  const attribute = isRecord(value) ? value : {};
  return {
    id: `reference-attribute-rule-${index}`,
    attributeKey: stringValue(attribute.attributeKey),
    valueRule: referenceValueRuleForm(attribute.value),
    optional: attribute.optional === true,
  };
}

function referenceRelationshipsText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      const relationship = isRecord(entry) ? entry : {};
      const fallback = stringValue(relationship.fallbackRuleKey);
      return `${stringValue(relationship.relationshipType)}=${stringValue(relationship.ruleKey)}${fallback ? `|${fallback}` : ""}`;
    })
    .join("\n");
}

function referenceHierarchyContractForm(value: unknown, index: number): ProfileReferenceHierarchyContractForm {
  const contract = isRecord(value) ? value : {};
  return {
    id: `reference-hierarchy-${index}`,
    targetTypeKey: stringValue(contract.targetTypeKey),
    providerAttributeKey: stringValue(contract.providerAttributeKey),
    referenceRecordKey: mappingExpressionFromUnknown(
      contract.referenceRecordKey,
      defaultPathExpression("", "external-reference", ["reference-hierarchy"]),
    ),
    parents: referenceHierarchyParentForms(contract.parent),
  };
}

function referenceHierarchyParentForms(value: unknown): readonly ProfileReferenceHierarchyParentForm[] {
  const parents: ProfileReferenceHierarchyParentForm[] = [];
  let current: unknown = value;
  let index = 0;
  while (isRecord(current)) {
    parents.push({
      id: `reference-hierarchy-parent-${index}`,
      targetTypeKey: stringValue(current.targetTypeKey),
      providerAttributeKey: stringValue(current.providerAttributeKey),
      referenceRecordKey: mappingExpressionFromUnknown(
        current.referenceRecordKey,
        defaultPathExpression("", "external-reference", ["reference-hierarchy"]),
      ),
    });
    current = current.parent;
    index += 1;
  }
  return parents;
}

function emptyProviderAttributeForm(): ProfileReferenceProviderAttributeForm {
  return {
    id: newFormRowId("reference-provider-attribute"),
    typeKey: "",
    providerAttributeKey: "",
  };
}

function emptyReferenceTypeRuleForm(): ProfileReferenceTypeRuleForm {
  return {
    id: newFormRowId("reference-type-rule"),
    referenceTypeId: "",
    typeKey: "",
    name: "",
    descriptionText: "",
    attributeKeysText: "",
  };
}

function emptyReferenceRecordRuleForm(): ProfileReferenceRecordRuleForm {
  return {
    id: newFormRowId("reference-record-rule"),
    ruleKey: "",
    typeKey: "",
    recordIdKind: "provider",
    staticReferenceRecordId: "",
    providerRecordTypeKey: "",
    providerValuePathsText: "",
    keyRule: emptyReferenceValueRuleForm("path"),
    nameRule: emptyReferenceValueRuleForm("path"),
    descriptionRule: emptyReferenceValueRuleForm("template"),
    attributes: [],
    requiredPathsText: "",
    relationshipsText: "",
  };
}

function emptyReferenceValueRuleForm(
  kind: ProfileReferenceValueRuleForm["kind"] = "static",
): ProfileReferenceValueRuleForm {
  return {
    kind,
    staticValue: "",
    path: "",
    template: "",
    templateValuesText: "",
  };
}

function emptyReferenceAttributeRuleForm(): ProfileReferenceAttributeRuleForm {
  return {
    id: newFormRowId("reference-attribute-rule"),
    attributeKey: "",
    valueRule: emptyReferenceValueRuleForm("path"),
    optional: true,
  };
}

function emptyReferenceHierarchyContractForm(): ProfileReferenceHierarchyContractForm {
  return {
    id: newFormRowId("reference-hierarchy"),
    targetTypeKey: "",
    providerAttributeKey: "",
    referenceRecordKey: defaultPathExpression("", "external-reference", ["reference-hierarchy"]),
    parents: [],
  };
}

function emptyReferenceHierarchyParentForm(): ProfileReferenceHierarchyParentForm {
  return {
    id: newFormRowId("reference-hierarchy-parent"),
    targetTypeKey: "",
    providerAttributeKey: "",
    referenceRecordKey: defaultPathExpression("", "external-reference", ["reference-hierarchy"]),
  };
}

function referenceHierarchyMappingFormToCommand(
  form: ProfileReferenceHierarchyForm,
): CatalogProviderProfileReferenceHierarchyUpdateCommand["referenceHierarchyMapping"] {
  return {
    ...form.rawMapping,
    providerReferenceIdPrefix: form.providerReferenceIdPrefix.trim(),
    providerAttributes: form.providerAttributes.map((attribute) => ({
      typeKey: attribute.typeKey.trim(),
      providerAttributeKey: attribute.providerAttributeKey.trim(),
    })),
    referenceTypes: form.referenceTypes.map(referenceTypeRuleFormToCommand),
    targetRecordRuleKey: form.targetRecordRuleKey.trim(),
    referenceRecords: mergeReferenceRecordRuleCommands(form.rawMapping.referenceRecords, form.recordRules),
  } as CatalogProviderProfileReferenceHierarchyUpdateCommand["referenceHierarchyMapping"];
}

function referenceTypeRuleFormToCommand(type: ProfileReferenceTypeRuleForm): Record<string, unknown> {
  return {
    referenceTypeId: type.referenceTypeId.trim(),
    typeKey: type.typeKey.trim(),
    name: type.name.trim(),
    descriptionText: type.descriptionText.trim(),
    attributeKeys: parseListInput(type.attributeKeysText),
  };
}

function mergeReferenceRecordRuleCommands(
  existingRules: unknown,
  rules: readonly ProfileReferenceRecordRuleForm[],
): readonly Record<string, unknown>[] {
  const existingById = new Map(
    (Array.isArray(existingRules) ? existingRules : [])
      .filter(isRecord)
      .map((rule) => [stringValue(rule.ruleKey), rule]),
  );
  return rules.map((rule) => referenceRecordRuleFormToCommand(rule, existingById.get(rule.ruleKey)));
}

function referenceRecordRuleFormToCommand(
  rule: ProfileReferenceRecordRuleForm,
  existingRule: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const relationships = referenceRelationshipsObject(rule.relationshipsText);
  return {
    ...existingRule,
    ruleKey: rule.ruleKey.trim(),
    typeKey: rule.typeKey.trim(),
    recordId: referenceRecordIdRuleToCommand(rule),
    key: referenceValueRuleToCommand(rule.keyRule),
    name: referenceValueRuleToCommand(rule.nameRule),
    description: referenceValueRuleToCommand(rule.descriptionRule),
    attributes: rule.attributes.map(referenceAttributeRuleToCommand),
    requiredPaths: parseListInput(rule.requiredPathsText),
    relationships,
  };
}

function referenceRecordIdRuleToCommand(rule: ProfileReferenceRecordRuleForm): Record<string, unknown> {
  if (rule.recordIdKind === "static") {
    return {
      kind: "static",
      referenceRecordId: rule.staticReferenceRecordId.trim(),
    };
  }
  return {
    kind: "provider",
    typeKey: rule.providerRecordTypeKey.trim(),
    providerValuePaths: parseListInput(rule.providerValuePathsText),
  };
}

function referenceAttributeRuleToCommand(attribute: ProfileReferenceAttributeRuleForm): Record<string, unknown> {
  return {
    attributeKey: attribute.attributeKey.trim(),
    value: referenceValueRuleToCommand(attribute.valueRule),
    ...(attribute.optional ? { optional: true } : {}),
  };
}

function referenceValueRuleToCommand(rule: ProfileReferenceValueRuleForm): Record<string, unknown> {
  if (rule.kind === "path") {
    return {
      kind: "path",
      path: rule.path.trim(),
    };
  }
  if (rule.kind === "template") {
    return {
      kind: "template",
      template: rule.template,
      values: referenceTemplateValuesObject(rule.templateValuesText),
    };
  }
  return {
    kind: "static",
    value: rule.staticValue,
  };
}

function referenceTemplateValuesObject(value: string): Readonly<Record<string, Record<string, unknown>>> {
  return Object.fromEntries(
    value
      .split(/\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...ruleParts] = entry.split("=");
        return [key.trim(), referenceInlineValueRuleToCommand(ruleParts.join("=").trim())] as const;
      })
      .filter(([key]) => key.length > 0),
  );
}

function referenceInlineValueRuleToCommand(value: string): Record<string, unknown> {
  if (value.startsWith("path:")) {
    return { kind: "path", path: value.slice("path:".length).trim() };
  }
  if (value.startsWith("static:")) {
    return { kind: "static", value: value.slice("static:".length).trim() };
  }
  return { kind: "path", path: value.trim() };
}

function referenceRelationshipsObject(value: string): readonly Record<string, string>[] {
  return value
    .split(/\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [relationshipType, ...ruleParts] = entry.split("=");
      const [ruleKey, fallbackRuleKey] = ruleParts.join("=").split("|");
      return {
        relationshipType: relationshipType.trim(),
        ruleKey: (ruleKey ?? "").trim(),
        ...(fallbackRuleKey?.trim() ? { fallbackRuleKey: fallbackRuleKey.trim() } : {}),
      };
    })
    .filter((relationship) => relationship.relationshipType.length > 0 && relationship.ruleKey.length > 0);
}

function referenceHierarchyContractsFormToCommand(
  form: ProfileReferenceHierarchyForm,
): CatalogProviderProfileReferenceHierarchyUpdateCommand["referenceHierarchyContracts"] {
  return form.contracts.map(
    referenceHierarchyContractFormToCommand,
  ) as CatalogProviderProfileReferenceHierarchyUpdateCommand["referenceHierarchyContracts"];
}

function referenceHierarchyContractFormToCommand(
  contract: ProfileReferenceHierarchyContractForm,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    targetTypeKey: contract.targetTypeKey.trim(),
    providerAttributeKey: contract.providerAttributeKey.trim(),
    referenceRecordKey: contract.referenceRecordKey,
  };
  const parent = referenceHierarchyParentsToCommand(contract.parents);
  if (parent) {
    node.parent = parent;
  }
  return node;
}

function referenceHierarchyParentsToCommand(
  parents: readonly ProfileReferenceHierarchyParentForm[],
): Record<string, unknown> | null {
  let child: Record<string, unknown> | null = null;
  for (const parent of [...parents].reverse()) {
    const node: Record<string, unknown> = {
      targetTypeKey: parent.targetTypeKey.trim(),
      providerAttributeKey: parent.providerAttributeKey.trim(),
      referenceRecordKey: parent.referenceRecordKey,
    };
    if (child) {
      node.parent = child;
    }
    child = node;
  }
  return child;
}

function validateReferenceHierarchyForm(form: ProfileReferenceHierarchyForm): string[] {
  const diagnostics: string[] = [];
  const ruleKeys = new Set(form.recordRules.map((rule) => rule.ruleKey.trim()).filter(Boolean));
  const typeKeys = new Set(form.referenceTypes.map((type) => type.typeKey.trim()).filter(Boolean));

  if (!form.providerReferenceIdPrefix.trim() || !form.targetRecordRuleKey.trim()) {
    diagnostics.push("Reference hierarchy: provider reference ID prefix and target record rule key are required.");
  }
  if (form.targetRecordRuleKey.trim() && !ruleKeys.has(form.targetRecordRuleKey.trim())) {
    diagnostics.push("Reference hierarchy: target record rule key must match a reference record rule.");
  }

  form.providerAttributes.forEach((attribute, index) => {
    if (!attribute.typeKey.trim() || !attribute.providerAttributeKey.trim()) {
      diagnostics.push(`Provider attribute ${index + 1}: type key and provider attribute key are required.`);
    }
    if (attribute.typeKey.trim() && typeKeys.size > 0 && !typeKeys.has(attribute.typeKey.trim())) {
      diagnostics.push(`Provider attribute ${index + 1}: type key must match a reference type.`);
    }
  });

  form.referenceTypes.forEach((type, index) => {
    const label = type.typeKey.trim() || `Reference type ${index + 1}`;
    if (!type.referenceTypeId.trim() || !type.typeKey.trim() || !type.name.trim() || !type.descriptionText.trim()) {
      diagnostics.push(`${label}: reference type ID, key, name, and description are required.`);
    }
  });

  form.recordRules.forEach((rule, index) => {
    const label = rule.ruleKey.trim() || `Reference record rule ${index + 1}`;
    if (!rule.ruleKey.trim() || !rule.typeKey.trim()) {
      diagnostics.push(`${label}: rule key and type key are required.`);
    }
    if (rule.typeKey.trim() && typeKeys.size > 0 && !typeKeys.has(rule.typeKey.trim())) {
      diagnostics.push(`${label}: type key must match a reference type.`);
    }
    if (rule.recordIdKind === "static" && !rule.staticReferenceRecordId.trim()) {
      diagnostics.push(`${label}: static reference record ID is required.`);
    }
    if (
      rule.recordIdKind === "provider" &&
      (!rule.providerRecordTypeKey.trim() || parseListInput(rule.providerValuePathsText).length === 0)
    ) {
      diagnostics.push(`${label}: provider record type key and provider value paths are required.`);
    }
    diagnostics.push(...validateReferenceValueRule(`${label} key`, rule.keyRule));
    diagnostics.push(...validateReferenceValueRule(`${label} name`, rule.nameRule));
    diagnostics.push(...validateReferenceValueRule(`${label} description`, rule.descriptionRule));
    rule.attributes.forEach((attribute, attributeIndex) => {
      const attributeLabel = `${label} attribute ${attributeIndex + 1}`;
      if (!attribute.attributeKey.trim()) {
        diagnostics.push(`${attributeLabel}: attribute key is required.`);
      }
      diagnostics.push(...validateReferenceValueRule(attributeLabel, attribute.valueRule));
    });
    for (const relationship of referenceRelationshipsObject(rule.relationshipsText)) {
      if (!ruleKeys.has(relationship.ruleKey)) {
        diagnostics.push(`${label}: relationship rule key '${relationship.ruleKey}' does not match a record rule.`);
      }
      if (relationship.fallbackRuleKey && !ruleKeys.has(relationship.fallbackRuleKey)) {
        diagnostics.push(
          `${label}: relationship fallback rule key '${relationship.fallbackRuleKey}' does not match a record rule.`,
        );
      }
    }
  });

  form.contracts.forEach((contract, index) => {
    const label = `Reference hierarchy chain ${index + 1}`;
    if (!contract.targetTypeKey.trim() || !contract.providerAttributeKey.trim()) {
      diagnostics.push(`${label}: target type key and provider attribute key are required.`);
    }
    diagnostics.push(...prefixedExpressionDiagnostics(`${label} reference key`, contract.referenceRecordKey));
    contract.parents.forEach((parent, parentIndex) => {
      const parentLabel = `${label} parent ${parentIndex + 1}`;
      if (!parent.targetTypeKey.trim() || !parent.providerAttributeKey.trim()) {
        diagnostics.push(`${parentLabel}: target type key and provider attribute key are required.`);
      }
      diagnostics.push(...prefixedExpressionDiagnostics(`${parentLabel} reference key`, parent.referenceRecordKey));
    });
  });

  return diagnostics;
}

function validateReferenceValueRule(label: string, rule: ProfileReferenceValueRuleForm): string[] {
  const diagnostics: string[] = [];
  if (rule.kind === "static" && !rule.staticValue.trim()) {
    diagnostics.push(`${label}: static value is required.`);
  }
  if (rule.kind === "path" && !rule.path.trim()) {
    diagnostics.push(`${label}: payload path is required.`);
  }
  if (rule.kind === "template") {
    if (!rule.template.trim()) {
      diagnostics.push(`${label}: template is required.`);
    }
    for (const token of rule.template.matchAll(/\{([^}]+)\}/g)) {
      const tokenName = token[1]?.trim();
      if (tokenName && !referenceTemplateValuesObject(rule.templateValuesText)[tokenName]) {
        diagnostics.push(`${label}: template token '${tokenName}' needs a template value.`);
      }
    }
  }
  return diagnostics;
}

function referenceHierarchyChainSummary(contract: ProfileReferenceHierarchyContractForm): string {
  return [contract.targetTypeKey, ...contract.parents.map((parent) => parent.targetTypeKey)]
    .filter(Boolean)
    .join(" > ");
}

function profileDuplicatePreventionForm(profile: CatalogProviderProfileVersionReview): ProfileDuplicatePreventionForm {
  const profileRecord = isRecord(profile.profile) ? profile.profile : {};
  const mapping = isRecord(profileRecord.duplicatePreventionMapping) ? profileRecord.duplicatePreventionMapping : {};
  const ambiguityRules = isRecord(profileRecord.ambiguityRules) ? profileRecord.ambiguityRules : {};
  const contractRoot = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : {};
  const duplicatePrevention = isRecord(contractRoot.duplicatePrevention) ? contractRoot.duplicatePrevention : {};
  const mergeCandidateEvidence = Array.isArray(duplicatePrevention.mergeCandidateEvidence)
    ? duplicatePrevention.mergeCandidateEvidence
    : [];
  const identityRules = Array.isArray(duplicatePrevention.identityRules) ? duplicatePrevention.identityRules : [];

  return {
    rawMapping: { ...mapping },
    rawAmbiguityRules: { ...ambiguityRules },
    exactExternalCatalogItemReferencesFirst: duplicatePrevention.exactExternalCatalogItemReferencesFirst !== false,
    ambiguousCandidatePolicy:
      duplicatePrevention.ambiguousCandidatePolicy === "review-only" ? "review-only" : "block-promotion",
    replayPolicy:
      duplicatePrevention.replayPolicy === "operator-reapply-active-version"
        ? "operator-reapply-active-version"
        : "same-profile-version",
    mergeCandidateEvidence: expressionListForm(mergeCandidateEvidence, "merge-candidate", ["merge-identity"]),
    identityRules: identityRules.map(duplicatePreventionRuleForm),
  };
}

function duplicatePreventionRuleForm(value: unknown, index: number): ProfileDuplicatePreventionRuleForm {
  const rule = isRecord(value) ? value : {};
  const evidence = Array.isArray(rule.evidence) ? rule.evidence : [];
  return {
    id: `duplicate-rule-${index}`,
    ruleKey: stringValue(rule.ruleKey),
    ruleKind: duplicatePreventionRuleKindValue(rule.ruleKind),
    candidatePolicy: rule.candidatePolicy === "review-only" ? "review-only" : "reuse",
    evidence: expressionListForm(evidence, `duplicate-rule-${index}-evidence`, ["merge-identity"]),
  };
}

function emptyDuplicatePreventionRuleForm(): ProfileDuplicatePreventionRuleForm {
  return {
    id: newFormRowId("duplicate-rule"),
    ruleKey: "",
    ruleKind: "deterministic-field-match",
    candidatePolicy: "review-only",
    evidence: [emptyExpressionListItemForm()],
  };
}

function duplicatePreventionMappingFormToCommand(
  form: ProfileDuplicatePreventionForm,
): CatalogProviderProfileDuplicatePreventionUpdateCommand["duplicatePreventionMapping"] {
  return {
    ...form.rawMapping,
    ambiguousCandidatePolicy: form.ambiguousCandidatePolicy,
    replayPolicy: form.replayPolicy,
    rules: mergeDuplicatePreventionMappingRules(form.rawMapping.rules, form.identityRules),
  } as CatalogProviderProfileDuplicatePreventionUpdateCommand["duplicatePreventionMapping"];
}

function mergeDuplicatePreventionMappingRules(
  existingRules: unknown,
  rules: readonly ProfileDuplicatePreventionRuleForm[],
): readonly Record<string, unknown>[] {
  const existingByKey = new Map(
    (Array.isArray(existingRules) ? existingRules : [])
      .filter(isRecord)
      .map((rule) => [stringValue(rule.ruleKey), rule]),
  );
  return rules.map((rule) => ({
    ...(existingByKey.get(rule.ruleKey) ?? {}),
    ruleKey: rule.ruleKey.trim(),
    matchKind: duplicatePreventionProfileMatchKind(rule.ruleKind),
    candidatePolicy: rule.candidatePolicy,
  }));
}

function duplicatePreventionAmbiguityRulesFormToCommand(
  form: ProfileDuplicatePreventionForm,
): CatalogProviderProfileDuplicatePreventionUpdateCommand["ambiguityRules"] {
  return form.rawAmbiguityRules as CatalogProviderProfileDuplicatePreventionUpdateCommand["ambiguityRules"];
}

function duplicatePreventionContractFormToCommand(
  form: ProfileDuplicatePreventionForm,
): CatalogProviderProfileDuplicatePreventionUpdateCommand["duplicatePreventionContract"] {
  return {
    exactExternalCatalogItemReferencesFirst: form.exactExternalCatalogItemReferencesFirst,
    mergeCandidateEvidence: form.mergeCandidateEvidence.map((item) => item.expression),
    identityRules: form.identityRules.map((rule) => ({
      ruleKey: rule.ruleKey.trim(),
      ruleKind: rule.ruleKind,
      evidence: rule.evidence.map((item) => item.expression),
      candidatePolicy: rule.candidatePolicy,
    })),
    ambiguousCandidatePolicy: form.ambiguousCandidatePolicy,
    replayPolicy: form.replayPolicy,
  } as CatalogProviderProfileDuplicatePreventionUpdateCommand["duplicatePreventionContract"];
}

function validateDuplicatePreventionForm(form: ProfileDuplicatePreventionForm): string[] {
  const diagnostics: string[] = [];
  const seenRuleKeys = new Set<string>();
  if (form.mergeCandidateEvidence.length === 0) {
    diagnostics.push("Duplicate prevention: merge candidate evidence needs at least one expression.");
  }
  form.mergeCandidateEvidence.forEach((item, index) => {
    diagnostics.push(...prefixedExpressionDiagnostics(`Merge candidate evidence ${index + 1}`, item.expression));
  });

  if (form.identityRules.length === 0) {
    diagnostics.push("Duplicate prevention: at least one identity rule is required.");
  }
  form.identityRules.forEach((rule, index) => {
    const label = rule.ruleKey.trim() || `Duplicate prevention rule ${index + 1}`;
    if (!rule.ruleKey.trim()) {
      diagnostics.push(`${label}: rule key is required.`);
    }
    if (seenRuleKeys.has(rule.ruleKey.trim())) {
      diagnostics.push(`${label}: rule keys must be unique.`);
    }
    seenRuleKeys.add(rule.ruleKey.trim());
    if (rule.evidence.length === 0) {
      diagnostics.push(`${label}: at least one evidence expression is required.`);
    }
    rule.evidence.forEach((item, evidenceIndex) => {
      diagnostics.push(...prefixedExpressionDiagnostics(`${label} evidence ${evidenceIndex + 1}`, item.expression));
    });
  });
  return diagnostics;
}

function duplicatePreventionRuleKindValue(value: unknown): ProfileDuplicatePreventionRuleForm["ruleKind"] {
  switch (value) {
    case "exact-external-catalog-item-reference":
    case "source-observation-link":
    case "deterministic-field-match":
    case "sealed-product-match":
    case "barcode-gtin-match":
    case "future-provider-bridge-match":
      return value;
    default:
      return "deterministic-field-match";
  }
}

function duplicatePreventionProfileMatchKind(ruleKind: ProfileDuplicatePreventionRuleForm["ruleKind"]): string {
  if (ruleKind === "deterministic-field-match") {
    return "deterministic-pokemon-card-field-match";
  }
  return ruleKind;
}

function profilePromotionPlanForm(profile: CatalogProviderProfileVersionReview): ProfilePromotionPlanForm {
  const contractRoot = isRecord(profile.executableMappingContract) ? profile.executableMappingContract : {};
  const promotionCommandPlan = isRecord(contractRoot.promotionCommandPlan) ? contractRoot.promotionCommandPlan : {};
  const commands = Array.isArray(promotionCommandPlan.commands) ? promotionCommandPlan.commands : [];
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: commands.map(promotionCommandForm),
  };
}

function promotionCommandForm(value: unknown, index: number): ProfilePromotionCommandForm {
  const command = isRecord(value) ? value : {};
  const inputs = isRecord(command.inputs) ? command.inputs : {};
  const commandName = promotionCommandNameValue(command.commandName);
  const rawCommandName = stringValue(command.commandName);
  return {
    id: `promotion-command-${index}`,
    unsupportedCommandName: rawCommandName && rawCommandName !== commandName ? rawCommandName : null,
    commandName,
    inputs: Object.entries(inputs).map(([fieldKey, expression], inputIndex) => ({
      id: `promotion-command-${index}-input-${inputIndex}`,
      fieldKey,
      expression: mappingExpressionFromUnknown(
        expression,
        defaultPathExpression("", "catalog-truth", ["promotion-command"]),
      ),
    })),
  };
}

function emptyPromotionCommandForm(): ProfilePromotionCommandForm {
  return {
    id: newFormRowId("promotion-command"),
    unsupportedCommandName: null,
    commandName: "SetCatalogItemFieldValue",
    inputs: [emptyPromotionCommandInputForm()],
  };
}

function emptyPromotionCommandInputForm(): ProfileExpressionFieldForm {
  return {
    id: newFormRowId("promotion-input"),
    fieldKey: "",
    expression: defaultPathExpression("", "catalog-truth", ["promotion-command"]),
  };
}

function promotionPlanFormToCommand(
  form: ProfilePromotionPlanForm,
): CatalogProviderProfilePromotionPlanUpdateCommand["promotionCommandPlan"] {
  return {
    planKind: "catalog-item-promotion",
    requiresReview: true,
    commands: form.commands.map((command) => ({
      commandName: command.commandName,
      inputs: Object.fromEntries(
        command.inputs.map((input) => [input.fieldKey.trim(), input.expression]).filter(([inputKey]) => inputKey),
      ),
    })),
  } as CatalogProviderProfilePromotionPlanUpdateCommand["promotionCommandPlan"];
}

function validatePromotionPlanForm(form: ProfilePromotionPlanForm, basics?: ProfileBasicsForm): string[] {
  const diagnostics: string[] = [];
  const hasPromotionCapability = basics?.capabilities.includes("catalog-item-promotion") ?? true;
  const outputKind = basics?.normalizedObservation.outputKind;
  if (form.commands.length > 0 && outputKind === "provider-product" && !hasPromotionCapability) {
    diagnostics.push(
      "Promotion command plan: provider-product profiles need the catalog-item-promotion capability before commands can be configured.",
    );
  }
  form.commands.forEach((command, commandIndex) => {
    const label = `Promotion command ${commandIndex + 1}`;
    if (command.unsupportedCommandName) {
      diagnostics.push(`${label}: unsupported command name "${command.unsupportedCommandName}".`);
    }
    if (command.inputs.length === 0) {
      diagnostics.push(`${label}: at least one input is required.`);
    }
    const seenInputs = new Set<string>();
    const inputKeys = new Set(command.inputs.map((input) => input.fieldKey.trim()).filter(Boolean));
    const missingRequiredInputs = promotionCommandRequiredInputKeys(command.commandName).filter(
      (inputKey) => !inputKeys.has(inputKey),
    );
    if (missingRequiredInputs.length > 0) {
      diagnostics.push(`${label}: missing required inputs ${missingRequiredInputs.join(", ")}.`);
    }
    command.inputs.forEach((input, inputIndex) => {
      const inputKey = input.fieldKey.trim();
      if (!inputKey) {
        diagnostics.push(`${label} input ${inputIndex + 1}: input key is required.`);
      }
      if (seenInputs.has(inputKey)) {
        diagnostics.push(`${label}: input keys must be unique.`);
      }
      seenInputs.add(inputKey);
      diagnostics.push(
        ...prefixedExpressionDiagnostics(`${label} input ${inputKey || inputIndex + 1}`, input.expression),
      );
      diagnostics.push(
        ...unsafePromotionCommandDiagnostics(`${label} input ${inputKey || inputIndex + 1}`, input.expression),
      );
    });
  });
  return diagnostics;
}

function promotionCommandNameValue(value: unknown): ProfilePromotionCommandForm["commandName"] {
  switch (value) {
    case "CreateCatalogItem":
    case "RefreshCatalogItem":
    case "ReviseCatalogItemMetadata":
    case "AssignBlueprintToCatalogItem":
    case "AssignCatalogItemToCategory":
    case "SetCatalogItemFieldValue":
    case "SetCatalogItemTags":
    case "SetCatalogItemImageUrls":
    case "SetCatalogItemProductAssetSets":
    case "LinkExternalCatalogItemReference":
    case "LinkExternalProductReference":
      return value;
    default:
      return "SetCatalogItemFieldValue";
  }
}

function unsafePromotionCommandDiagnostics(label: string, expression: MappingExpressionValue): string[] {
  const diagnostics: string[] = [];
  for (const candidate of expressionTree(expression)) {
    const selectorPath = selectorEvidencePath(candidate.selector).toLowerCase();
    const unsafePath = [
      "price",
      "pricing",
      "inventory",
      "seller",
      "listing",
      "order",
      "message",
      "auth",
      "cookie",
    ].some((token) => selectorPath.includes(token));
    const unsafeOwner =
      candidate.owner === "pricing-signal" ||
      candidate.owner === "inventory-signal" ||
      candidate.owner === "operations";
    const unsafeRedaction = candidate.redaction !== "none";
    const drivesPromotion = candidate.uses.includes("promotion-command");

    if ((unsafeOwner || unsafeRedaction || unsafePath) && drivesPromotion) {
      diagnostics.push(
        `${label}: promotion command cannot use secret, pricing, inventory, operations, seller, listing, order, or message evidence.`,
      );
      break;
    }
  }
  return diagnostics;
}

function profileConnectorForm(value: unknown): ProfileConnectorForm {
  const connector = isRecord(value) ? value : {};
  const tcgdexEndpoints = isRecord(connector.endpoints) ? connector.endpoints : {};
  const tcgplayerRepository = isRecord(connector.sourceRepository) ? connector.sourceRepository : {};
  const tcgplayerAuthentication = isRecord(connector.authentication) ? connector.authentication : {};
  const tcgplayerDomains = isRecord(connector.domains) ? connector.domains : {};

  return {
    kind: stringValue(connector.kind) || "scrydex-scryfall-json",
    tcgdexBaseUrl: stringValue(connector.baseUrl) || "https://api.tcgdex.net/v2",
    tcgdexHighQualityAssetVariant: stringValue(connector.highQualityAssetVariant) || "high.webp",
    tcgdexSeriesListEndpoint: stringValue(tcgdexEndpoints.seriesList) || "/{language}/series",
    tcgdexSeriesDetailEndpoint: stringValue(tcgdexEndpoints.seriesDetail) || "/{language}/series/{seriesId}",
    tcgdexExpansionListEndpoint: stringValue(tcgdexEndpoints.expansionList) || "/{language}/sets",
    tcgdexExpansionDetailEndpoint: stringValue(tcgdexEndpoints.expansionDetail) || "/{language}/sets/{expansionId}",
    tcgdexProductDetailEndpoint: stringValue(tcgdexEndpoints.productDetail) || "/{language}/cards/{cardId}",
    tcgplayerRepositoryOwner: stringValue(tcgplayerRepository.owner) || "todd-skelton",
    tcgplayerRepositoryName: stringValue(tcgplayerRepository.name) || "tcgplayer-automation-app",
    tcgplayerRepositoryCommit: stringValue(tcgplayerRepository.commit),
    tcgplayerSourceContractDocument:
      stringValue(connector.sourceContractDocument) ||
      "bounded-contexts/catalog/docs/tcgplayer-automation-client-contract.md",
    tcgplayerCookieName: stringValue(tcgplayerAuthentication.cookieName) || "TCGAuthTicket_Production",
    tcgplayerSearchDomain: stringValue(tcgplayerDomains.search) || "mp-search-api.tcgplayer.com",
    tcgplayerMarketplaceApiDomain: stringValue(tcgplayerDomains.marketplaceApi) || "mpapi.tcgplayer.com",
    tcgplayerInfiniteApiDomain: stringValue(tcgplayerDomains.infiniteApi) || "infinite-api.tcgplayer.com",
    tcgplayerMarketplaceGatewayDomain: stringValue(tcgplayerDomains.marketplaceGateway) || "mpgateway.tcgplayer.com",
    tcgplayerRetryStatusCodesText: Array.isArray(connector.retryStatusCodes)
      ? connector.retryStatusCodes.map(String).join(", ")
      : "403, 429, 502, 503, 504",
    scrydexSourceContractDocument:
      stringValue(connector.sourceContractDocument) || "bounded-contexts/catalog/docs/provider-integration-profiles.md",
    scrydexAcceptedEvidenceText: arrayText(connector.acceptedEvidence),
    scrydexExcludedEvidenceText: arrayText(connector.excludedEvidence),
  };
}

function connectorFormToCommand(
  connector: ProfileConnectorForm,
): CatalogProviderProfileConnectorUpdateCommand["connector"] {
  if (connector.kind === "tcgdex-json") {
    return {
      kind: "tcgdex-json",
      baseUrl: connector.tcgdexBaseUrl.trim(),
      highQualityAssetVariant: connector.tcgdexHighQualityAssetVariant.trim(),
      endpoints: {
        seriesList: connector.tcgdexSeriesListEndpoint.trim(),
        seriesDetail: connector.tcgdexSeriesDetailEndpoint.trim(),
        expansionList: connector.tcgdexExpansionListEndpoint.trim(),
        expansionDetail: connector.tcgdexExpansionDetailEndpoint.trim(),
        productDetail: connector.tcgdexProductDetailEndpoint.trim(),
      },
    };
  }

  if (connector.kind === "tcgplayer-automation-client") {
    return {
      kind: "tcgplayer-automation-client",
      sourceRepository: {
        owner: connector.tcgplayerRepositoryOwner.trim(),
        name: connector.tcgplayerRepositoryName.trim(),
        commit: connector.tcgplayerRepositoryCommit.trim(),
      },
      sourceContractDocument: connector.tcgplayerSourceContractDocument.trim(),
      authentication: {
        scheme: "tcgplayer-production-cookie",
        cookieName: connector.tcgplayerCookieName.trim(),
        userAgentRequired: true,
      },
      domains: {
        search: connector.tcgplayerSearchDomain.trim(),
        marketplaceApi: connector.tcgplayerMarketplaceApiDomain.trim(),
        infiniteApi: connector.tcgplayerInfiniteApiDomain.trim(),
        marketplaceGateway: connector.tcgplayerMarketplaceGatewayDomain.trim(),
      },
      retryStatusCodes: parseNumberListInput(connector.tcgplayerRetryStatusCodesText),
      throttling: {
        strategy: "domain-adaptive",
        controls: ["request-delay", "cooldown", "max-concurrency", "learned-min-delay"],
      },
      catalogFlow: {
        productLineScope: "product-lines",
        setScope: "catalog-set-names-by-product-line",
        productScope: "product-search-by-set",
        detailScope: "product-detail-with-skus",
        detectsProductSetReclassification: true,
      },
      externalReferencePolicy: {
        catalogItemReferencePrefix: "product:",
        productReferencePrefix: "sku:",
        productConditionIdSource: "sku-product-condition-id",
      },
      catalogBoundary: {
        acceptedEvidence: ["product-id", "sku-id", "product-condition-id", "set-name", "product-line"],
        excludedEvidence: ["listing-price", "sales-history", "order", "message", "seller-inventory"],
      },
    };
  }

  return {
    kind: "scrydex-scryfall-json",
    sourceContractDocument: connector.scrydexSourceContractDocument.trim(),
    fixtureBackedOnly: true,
    acceptedEvidence: parseListInput(connector.scrydexAcceptedEvidenceText),
    excludedEvidence: parseListInput(connector.scrydexExcludedEvidenceText),
  };
}

function validateConnectorForm(connector: ProfileConnectorForm): string[] {
  if (connector.kind === "tcgdex-json") {
    return requiredConnectorFields("TCGdex connector", [
      connector.tcgdexBaseUrl,
      connector.tcgdexHighQualityAssetVariant,
      connector.tcgdexSeriesListEndpoint,
      connector.tcgdexSeriesDetailEndpoint,
      connector.tcgdexExpansionListEndpoint,
      connector.tcgdexExpansionDetailEndpoint,
      connector.tcgdexProductDetailEndpoint,
    ]);
  }
  if (connector.kind === "tcgplayer-automation-client") {
    return requiredConnectorFields("TCGplayer connector", [
      connector.tcgplayerRepositoryOwner,
      connector.tcgplayerRepositoryName,
      connector.tcgplayerRepositoryCommit,
      connector.tcgplayerSourceContractDocument,
      connector.tcgplayerCookieName,
      connector.tcgplayerSearchDomain,
      connector.tcgplayerMarketplaceApiDomain,
      connector.tcgplayerInfiniteApiDomain,
      connector.tcgplayerMarketplaceGatewayDomain,
    ]);
  }
  return requiredConnectorFields("Scrydex connector", [connector.scrydexSourceContractDocument]);
}

function requiredConnectorFields(label: string, values: readonly string[]): string[] {
  return values.some((value) => !value.trim()) ? [`${label}: required connector fields are missing.`] : [];
}

function profileOptionQueryForm(value: unknown, index: number): ProfileOptionQueryForm {
  const query = isRecord(value) ? value : {};
  const output = isRecord(query.output) ? query.output : {};
  const parentValue = isRecord(query.parentValue) ? query.parentValue : null;
  const description = isRecord(output.description) ? output.description : null;

  return {
    id: `${stringValue(query.queryKind) || "query"}-${index}`,
    queryKind: stringValue(query.queryKind),
    aliasesText: arrayText(query.aliases),
    displayName: stringValue(query.displayName),
    scope: stringValue(query.scope) || "product/card",
    parentScope: stringValue(query.parentScope) || "__none__",
    parentRequired: parentValue?.required === true,
    parentValueKind: stringValue(parentValue?.valueKind),
    parentDiagnosticText: stringValue(parentValue?.diagnosticText),
    operation: stringValue(query.operation) || OPTION_QUERY_OPERATION_OPTIONS[0].value,
    valuePath: stringValue(output.valuePath),
    labelPath: stringValue(output.labelPath),
    descriptionKind: stringValue(description?.kind) || "__none__",
    descriptionPath: stringValue(description?.path),
    parentValuePath: stringValue(output.parentValuePath),
    imageUrlPath: stringValue(output.imageUrlPath),
    imageUrlCoalescePathsText: arrayText(output.imageUrlCoalescePaths),
    metadataPathsText: metadataPathsText(output.metadataPaths),
  };
}

function emptyOptionQueryForm(): ProfileOptionQueryForm {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queryKind: "",
    aliasesText: "",
    displayName: "",
    scope: "product/card",
    parentScope: "__none__",
    parentRequired: false,
    parentValueKind: "",
    parentDiagnosticText: "",
    operation: OPTION_QUERY_OPERATION_OPTIONS[0].value,
    valuePath: "",
    labelPath: "",
    descriptionKind: "__none__",
    descriptionPath: "",
    parentValuePath: "",
    imageUrlPath: "",
    imageUrlCoalescePathsText: "",
    metadataPathsText: "",
  };
}

function optionQueryFormToCommand(
  query: ProfileOptionQueryForm,
): CatalogProviderProfileProviderOptionsUpdateCommand["optionQueries"][number] {
  const output: CatalogProviderProfileProviderOptionsUpdateCommand["optionQueries"][number]["output"] = {
    valuePath: query.valuePath.trim(),
    labelPath: query.labelPath.trim(),
    metadataPaths: metadataPathsObject(query.metadataPathsText),
  };
  const parentValuePath = nullableTrimmedValue(query.parentValuePath);
  const imageUrlPath = nullableTrimmedValue(query.imageUrlPath);
  const imageUrlCoalescePaths = parseListInput(query.imageUrlCoalescePathsText);
  if (parentValuePath) {
    output.parentValuePath = parentValuePath;
  }
  if (imageUrlPath) {
    output.imageUrlPath = imageUrlPath;
  }
  if (imageUrlCoalescePaths.length > 0) {
    output.imageUrlCoalescePaths = imageUrlCoalescePaths;
  }
  if (query.descriptionKind === "path" && query.descriptionPath.trim()) {
    output.description = { kind: "path", path: query.descriptionPath.trim() };
  } else if (query.descriptionKind !== "__none__" && query.descriptionKind !== "path") {
    output.description = { kind: query.descriptionKind };
  }

  const command: CatalogProviderProfileProviderOptionsUpdateCommand["optionQueries"][number] = {
    queryKind: query.queryKind.trim(),
    displayName: query.displayName.trim(),
    scope: query.scope,
    parentScope: query.parentScope === "__none__" ? null : query.parentScope,
    operation: query.operation,
    output,
  };
  const aliases = parseListInput(query.aliasesText);
  if (aliases.length > 0) {
    command.aliases = aliases;
  }
  if (query.parentScope !== "__none__") {
    command.parentValue = {
      required: query.parentRequired,
      valueKind: query.parentValueKind.trim(),
      diagnosticText: query.parentDiagnosticText.trim(),
    };
  }

  return command;
}

export function providerOptionImportSurface(providerKey: string, query: ProfileOptionQueryForm): string {
  const operation = query.operation.trim();
  if (providerKey === TCGDEX_PROVIDER || operation.startsWith("tcgdex-")) {
    if (operation === "tcgdex-list-languages") {
      return "Pull Provider Data: TCGdex language selector.";
    }
    if (operation === "tcgdex-list-series") {
      return "Pull Provider Data: TCGdex series selector after language.";
    }
    if (operation === "tcgdex-list-expansions") {
      return "Source Observations: expansion filter and expansion-backed review scopes.";
    }
    return "TCGdex option surface.";
  }

  if (providerKey === TCGPLAYER_PROVIDER || operation.startsWith("tcgplayer-")) {
    if (operation === "tcgplayer-list-product-lines") {
      return "Pull Provider Data: TCGplayer product-line selector.";
    }
    if (operation === "tcgplayer-list-set-names") {
      return "Pull Provider Data: TCGplayer set selector after product line.";
    }
    if (operation === "tcgplayer-list-products") {
      return "Pull Provider Data: TCGplayer product import scope.";
    }
    if (operation === "tcgplayer-list-skus") {
      return "Future TCGplayer SKU option surface.";
    }
    return "TCGplayer option surface.";
  }

  if (operation === "scrydex-list-sets") {
    return "Scrydex set selector for provider review scopes.";
  }

  return query.scope.trim() ? `Provider option surface for ${query.scope.trim()}.` : "Provider option surface.";
}

export function providerOptionParentPreview(query: ProfileOptionQueryForm): string {
  if (query.parentScope === "__none__") {
    return "No parent scope required.";
  }

  const requirement = query.parentRequired ? "requires" : "uses";
  const valueKind = query.parentValueKind.trim() || "parent value";
  const path = query.parentValuePath.trim() || "no output parent path";
  return `${query.parentScope} ${requirement} ${valueKind}; parent output path: ${path}.`;
}

export function providerOptionOutputPreview(query: ProfileOptionQueryForm): string {
  const valuePath = query.valuePath.trim() || "missing value path";
  const labelPath = query.labelPath.trim() || "missing label path";
  const description =
    query.descriptionKind === "path"
      ? `description path: ${query.descriptionPath.trim() || "missing"}`
      : query.descriptionKind === "__none__"
        ? "no description"
        : `description kind: ${query.descriptionKind}`;
  const image =
    query.imageUrlPath.trim() || parseListInput(query.imageUrlCoalescePathsText).length > 0
      ? "image configured"
      : "no image";
  return `value: ${valuePath}; label: ${labelPath}; ${description}; ${image}.`;
}

export function providerOptionMetadataPreview(query: ProfileOptionQueryForm): string {
  const metadata = metadataPathsObject(query.metadataPathsText);
  const entries = Object.entries(metadata).map(([key, path]) => `${key}=${path}`);
  return entries.length > 0 ? entries.join(", ") : "No metadata paths.";
}

export function providerOptionSamplePreview(query: ProfileOptionQueryForm, payload: JsonValue) {
  const diagnostics: string[] = [];
  const output: Record<string, JsonValue> = {
    value: providerOptionPreviewPath(query.valuePath, payload, "value path", diagnostics),
    label: providerOptionPreviewPath(query.labelPath, payload, "label path", diagnostics),
  };
  if (query.parentValuePath.trim()) {
    output.parentValue = providerOptionPreviewPath(query.parentValuePath, payload, "parent value path", diagnostics);
  }
  if (query.imageUrlPath.trim()) {
    output.imageUrl = providerOptionPreviewPath(query.imageUrlPath, payload, "image URL path", diagnostics);
  }
  const coalescedImage = parseListInput(query.imageUrlCoalescePathsText)
    .map((path) => providerOptionPreviewPath(path, payload, `image coalesce path '${path}'`, diagnostics))
    .find((value) => value !== null && value !== "");
  if (coalescedImage !== undefined) {
    output.coalescedImageUrl = coalescedImage;
  }
  const metadata = Object.fromEntries(
    Object.entries(metadataPathsObject(query.metadataPathsText)).map(([key, path]) => [
      key,
      providerOptionPreviewPath(path, payload, `metadata path '${key}'`, diagnostics),
    ]),
  ) as Record<string, JsonValue>;
  if (Object.keys(metadata).length > 0) {
    output.metadata = metadata;
  }
  return { output, diagnostics };
}

function providerOptionPreviewPath(path: string, payload: JsonValue, label: string, diagnostics: string[]): JsonValue {
  if (!path.trim()) {
    diagnostics.push(`${label} is not configured.`);
    return null;
  }
  const preview = previewMappingExpression(
    defaultPathExpression(path, "external-reference", ["source-payload"]),
    payload,
  );
  diagnostics.push(...preview.diagnostics.map((diagnostic) => `${label}: ${diagnostic}`));
  return preview.value;
}

function validateOptionQueryForms(queries: readonly ProfileOptionQueryForm[]): string[] {
  const diagnostics: string[] = [];
  const seenKeys = new Set<string>();

  queries.forEach((query, index) => {
    const label = query.displayName.trim() || query.queryKind.trim() || `Option query ${index + 1}`;
    if (!query.queryKind.trim()) {
      diagnostics.push(`${label}: query kind is required.`);
    }
    if (!query.displayName.trim()) {
      diagnostics.push(`${label}: display name is required.`);
    }
    if (!query.valuePath.trim() || !query.labelPath.trim()) {
      diagnostics.push(`${label}: value path and label path are required.`);
    }
    if (query.descriptionKind === "path" && !query.descriptionPath.trim()) {
      diagnostics.push(`${label}: description path is required when description uses a path.`);
    }
    if (query.parentScope !== "__none__" && (!query.parentValueKind.trim() || !query.parentDiagnosticText.trim())) {
      diagnostics.push(`${label}: parent value kind and diagnostic are required when a parent scope is selected.`);
    }

    for (const key of [query.queryKind, ...parseListInput(query.aliasesText)]) {
      const normalized = key.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (seenKeys.has(normalized)) {
        diagnostics.push(`${label}: query kind and aliases must be unique.`);
        break;
      }
      seenKeys.add(normalized);
    }
  });

  return diagnostics;
}

function metadataPathsText(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return Object.entries(value)
    .map(([key, path]) => `${key}=${String(path)}`)
    .join("\n");
}

function metadataPathsObject(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...pathParts] = entry.split("=");
        return [key.trim(), pathParts.join("=").trim()];
      })
      .filter(([key, path]) => key.length > 0 && path.length > 0),
  );
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join("\n") : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toggleStringSelection(selected: readonly string[], option: string): readonly string[] {
  return selected.includes(option) ? selected.filter((entry) => entry !== option) : [...selected, option];
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): readonly T[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

function insertItem<T>(items: readonly T[], index: number, item: T): readonly T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function newFormRowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyMigrationEvidenceForm(): MigrationEvidenceForm {
  return {
    mappingFingerprintBefore: "",
    mappingFingerprintAfter: "",
    fixtureRunId: "",
    replayScope: "",
    observedImpact: "",
    operatorNote: "",
  };
}

function emptyDryRunSafeOverrides(): DryRunSafeOverrides {
  return {
    name: "",
    language: "",
    sourceUpdatedAt: "",
    sampleFields: {},
  };
}

function migrationEvidenceFormFromProfile(profile: CatalogProviderProfileVersionReview): MigrationEvidenceForm {
  return {
    ...emptyMigrationEvidenceForm(),
    mappingFingerprintBefore: profile.migrationEvidence?.mappingFingerprintBefore ?? "",
    mappingFingerprintAfter: profile.migrationEvidence?.mappingFingerprintAfter ?? "",
    fixtureRunId: profile.migrationEvidence?.fixtureRunId ?? "",
    operatorNote: profile.migrationEvidence?.evidenceText ?? "",
  };
}

function migrationEvidenceReady(form: MigrationEvidenceForm): boolean {
  return Boolean(
    form.fixtureRunId.trim() && form.replayScope.trim() && form.observedImpact.trim() && form.operatorNote.trim(),
  );
}

function activationConfirmationBlocked(model: CatalogProviderProfileAuthoringModel | null, loading: boolean): boolean {
  return loading || !model || model.activationReadiness.status !== "ready";
}

function migrationEvidenceFromForm(
  form: MigrationEvidenceForm,
  authoringModel: CatalogProviderProfileAuthoringModel | null,
) {
  const fingerprints = authoringModel?.semanticDiff.mappingFingerprint;
  const mappingFingerprintBefore = nullableTrimmedValue(form.mappingFingerprintBefore) ?? fingerprints?.active ?? null;
  const mappingFingerprintAfter = nullableTrimmedValue(form.mappingFingerprintAfter) ?? fingerprints?.candidate ?? null;

  return {
    evidenceText: [
      `Fixture run: ${form.fixtureRunId.trim()}`,
      `Replay scope: ${form.replayScope.trim()}`,
      `Observed impact: ${form.observedImpact.trim()}`,
      `Operator note: ${form.operatorNote.trim()}`,
    ].join("\n"),
    mappingFingerprintBefore,
    mappingFingerprintAfter,
    fixtureRunId: nullableTrimmedValue(form.fixtureRunId),
  };
}

function dryRunFixtureItems(model: CatalogProviderProfileAuthoringModel): SelectItem[] {
  return model.fixtureCases.map((fixtureCase) => ({
    value: fixtureCase.flow,
    label: `${fixtureCase.flow}${fixtureCase.samplePayloadAvailable ? "" : " (missing sample)"}`,
    disabled: !fixtureCase.samplePayloadAvailable,
  }));
}

function applyDryRunSafeOverrides(payload: JsonValue | null, overrides: DryRunSafeOverrides): JsonValue | null {
  if (!isRecord(payload)) {
    return payload;
  }

  const next: Record<string, JsonValue> = { ...(payload as Record<string, JsonValue>) };
  for (const [key, value] of Object.entries(overrides.sampleFields)) {
    const trimmedValue = value.trim();
    if (!trimmedValue || !isSafeDryRunSampleFieldKey(key) || !Object.prototype.hasOwnProperty.call(next, key)) {
      continue;
    }
    next[key] = coerceDryRunSampleFieldValue(next[key], trimmedValue);
  }

  const name = overrides.name.trim();
  const language = overrides.language.trim();
  const sourceUpdatedAt = overrides.sourceUpdatedAt.trim();

  if (name) {
    setFirstExistingOrDefault(next, ["name", "productName", "cardName"], "name", name);
  }
  if (language) {
    setFirstExistingOrDefault(next, ["languageCode", "language", "lang"], "languageCode", language);
  }
  if (sourceUpdatedAt) {
    setFirstExistingOrDefault(
      next,
      ["sourceUpdatedAt", "source_updated_at", "updatedAt", "updated_at"],
      "sourceUpdatedAt",
      sourceUpdatedAt,
    );
  }

  return next;
}

function dryRunSampleFieldOverrideItems(model: CatalogProviderProfileAuthoringModel, flow: string) {
  const payload = selectedDryRunPayload(model, flow);
  if (!isRecord(payload)) {
    return [];
  }

  return Object.entries(payload)
    .filter(([key, value]) => isSafeDryRunSampleFieldKey(key) && isDryRunEditablePrimitive(value))
    .slice(0, 8)
    .map(([key, value]) => ({
      key,
      label: readableFieldLabel(key),
      value,
    }));
}

function isSafeDryRunSampleFieldKey(key: string): boolean {
  return (
    !DRY_RUN_MANAGED_SAMPLE_FIELD_KEYS.has(key) &&
    !/auth|cookie|secret|token|password|seller|listing|price|inventory|order|message/i.test(key)
  );
}

function isDryRunEditablePrimitive(value: JsonValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function coerceDryRunSampleFieldValue(existingValue: JsonValue, value: string): JsonValue {
  if (typeof existingValue === "number") {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : existingValue;
  }
  if (typeof existingValue === "boolean") {
    return value.toLowerCase() === "true";
  }
  return value;
}

function readableFieldLabel(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const DRY_RUN_MANAGED_SAMPLE_FIELD_KEYS = new Set([
  "name",
  "productName",
  "cardName",
  "languageCode",
  "language",
  "lang",
  "sourceUpdatedAt",
  "source_updated_at",
  "updatedAt",
  "updated_at",
]);

function setFirstExistingOrDefault(
  target: Record<string, JsonValue>,
  candidates: readonly string[],
  fallback: string,
  value: string,
) {
  const key = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(target, candidate)) ?? fallback;
  target[key] = value;
}

function selectedDryRunFixture(model: CatalogProviderProfileAuthoringModel | null, flow: string) {
  return model?.fixtureCases.find((fixtureCase) => fixtureCase.flow === flow) ?? null;
}

function selectedDryRunPayload(model: CatalogProviderProfileAuthoringModel | null, flow: string) {
  const fixture = selectedDryRunFixture(model, flow);
  return fixture?.samplePayload ?? model?.dryRunInputTemplate.payload ?? null;
}

function dryRunDiagnosticGroups(
  diagnostics: CatalogProviderProfileDryRunResult["diagnostics"],
  flow: string,
): { flow: string; section: string; count: number; path: string }[] {
  const groups = new Map<string, { flow: string; section: string; count: number; path: string }>();
  for (const diagnostic of diagnostics) {
    const section = dryRunDiagnosticSection(diagnostic.path);
    const existing = groups.get(section);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(section, { flow, section, count: 1, path: diagnostic.path });
    }
  }
  return [...groups.values()];
}

function dryRunDiagnosticSection(pathValue: string): string {
  const root = pathValue.split(/[.[\]]/).find((part) => part.trim());
  if (!root) {
    return "Profile";
  }
  return humanizeIdentifier(root);
}

function dryRunRedactionSummary(result: CatalogProviderProfileDryRunResult) {
  const evidence = [
    ...result.hashMaterial,
    ...result.mergeCandidateEvidence,
    ...result.duplicatePreventionRules.flatMap((rule) => rule.evidence),
    ...result.promotionCommandPlan.commands.flatMap((command) => command.inputs),
  ];
  const counts = new Map<string, number>();
  for (const item of evidence) {
    counts.set(item.redaction, (counts.get(item.redaction) ?? 0) + 1);
  }
  const payloadRedactionCount = countRedactedPayloadValues(result.redactedPayload);
  return [
    { key: "Payload redacted fields", value: String(payloadRedactionCount) },
    {
      key: "Evidence redaction categories",
      value:
        counts.size > 0
          ? [...counts.entries()].map(([redaction, count]) => `${redaction}: ${count}`).join(", ")
          : "None",
    },
  ];
}

function countRedactedPayloadValues(value: JsonValue): number {
  if (typeof value === "string") {
    return value.toLowerCase().includes("redacted") ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((count, item) => count + countRedactedPayloadValues(item), 0);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>(
      (count, item) => count + countRedactedPayloadValues(item as JsonValue),
      0,
    );
  }
  return 0;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function summarizeDiffValue(
  value: CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]["candidate"],
): string {
  return summarizeJsonValue(value);
}

function summarizeJsonValue(
  value: CatalogProviderProfileAuthoringModel["semanticDiff"]["changes"][number]["candidate"],
): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "None" : value.map((entry) => summarizeJsonValue(entry)).join(", ");
  }
  if (typeof value === "object") {
    if ("externalKey" in value && typeof value.externalKey === "string") {
      return value.externalKey;
    }
    if ("optionKey" in value && typeof value.optionKey === "string") {
      return value.optionKey;
    }
    if ("dimensionKey" in value && typeof value.dimensionKey === "string") {
      return value.dimensionKey;
    }
    return Object.keys(value).length === 0 ? "None" : `${Object.keys(value).length} fields`;
  }
  return String(value);
}

function defaultDryRunPayload(providerKey = "scrydex"): string {
  if (providerKey === "scrydex") {
    return formatJson({
      object: "card",
      id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
      name: "Fury Sliver",
      lang: "en",
      released_at: "2006-10-06",
      scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
      set: "tsp",
      set_name: "Time Spiral",
      collector_number: "157",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
      },
      tcgplayer_id: 14240,
      prices: {
        usd: "0.42",
      },
    });
  }

  if (providerKey === TCGPLAYER_PROVIDER) {
    return formatJson({
      observationId: "tcgplayer_en_product_610001",
      externalKey: "product:610001",
      sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
      sourceUpdatedAt: "2025-01-17",
      sourcePayload: {
        productId: 610001,
        productName: "Eevee ex",
      },
      productId: 610001,
      productName: "Eevee ex",
      productLineName: "Pokemon",
      productLineId: 3,
      productTypeName: "Cards",
      setName: "Prismatic Evolutions",
      customAttributes: { number: "167/131" },
      externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      externalProductReferences: [],
      skuReferences: [],
      productForm: "single",
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon",
        setName: "Prismatic Evolutions",
        printedProductName: "Eevee ex",
        collectorNumber: "167/131",
        languageCode: "en",
        productForm: "single",
      },
      catalogHashMaterial: {
        productId: 610001,
        productName: "Eevee ex",
        setName: "Prismatic Evolutions",
        number: "167/131",
      },
      marketPrice: "redacted by dry-run",
    });
  }

  return formatJson({
    observationId: "tcgdex_en_fixture",
    externalKey: "fixture",
    sourceUrl: "https://example.invalid/provider-fixture",
    sourceUpdatedAt: "2026-06-03",
    sourcePayload: {},
    languageCode: "en",
  });
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sourceObservationScopeHref(scope: SourceObservationIntegrationScope) {
  const params = new URLSearchParams();
  params.set("source", scope.provider_key);
  params.set("language", scope.language_code);

  if (scope.expansion_id) {
    params.set("setId", scope.expansion_id);
  }

  return `/catalog/source-observations?${params.toString()}`;
}

function sourceObservationIntegrationJobScopeHref(scope: SourceObservationIntegrationJobScope) {
  const params = new URLSearchParams();

  if (scope.provider) {
    params.set("source", scope.provider);
  }

  if (scope.language) {
    params.set("language", scope.language);
  }

  if (scope.setId) {
    params.set("setId", scope.setId);
  }

  const query = params.toString();
  return query ? `/catalog/source-observations?${query}` : "/catalog/source-observations";
}

function sourceObservationOutcomeHref(outcome: SourceObservationIntegrationJobOutcome) {
  return sourceObservationIntegrationJobScopeHref({
    provider: outcome.providerKey,
    language: outcome.languageCode,
    setId: outcome.expansionId ?? undefined,
  });
}

function sourceObservationPromotionScopeHref(scope: SourceObservationPromotionScope) {
  const params = new URLSearchParams();

  if (scope.provider) {
    params.set("source", scope.provider);
  }

  if (scope.language) {
    params.set("language", scope.language);
  }

  if (scope.setId) {
    params.set("setId", scope.setId);
  }

  const query = params.toString();
  return query ? `/catalog/source-observations?${query}` : "/catalog/source-observations";
}

function positiveIntegerText(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function queuedProgress(): CatalogBulkActionProgress {
  return {
    phase: "queued",
    completed: 0,
    total: 0,
    currentName: null,
    status: null,
  };
}

function bulkActionProgressPercent(progress: CatalogBulkActionProgress): number {
  if (progress.phase === "completed") {
    return 100;
  }

  if (progress.total <= 0) {
    return 0;
  }

  return (progress.completed / progress.total) * 100;
}

function formatBulkActionProgress(progress: CatalogBulkActionProgress): string {
  if (progress.phase === "queued") {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.queued");
  }

  if (progress.total <= 0) {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.preparing");
  }

  if (progress.phase === "completed") {
    return t("catalog.features.sourceObservations.ui.list.bulk.progress.completed", {
      completed: String(progress.completed),
      total: String(progress.total),
    });
  }

  return t("catalog.features.sourceObservations.ui.list.bulk.progress.processing", {
    completed: String(progress.completed),
    total: String(progress.total),
  });
}

function formatReapplyScope(scope: Required<SourceObservationPromotionScope>): string {
  const parts = [
    scope.search
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.search", {
          search: scope.search,
        })
      : "",
    scope.language
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.language", {
          language: formatLanguageCodeLabel(scope.language),
        })
      : "",
    scope.provider
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.provider", {
          provider: scope.provider,
        })
      : "",
    scope.setId
      ? t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.expansion", {
          setId: scope.setId,
        })
      : "",
  ].filter(Boolean);

  return parts.length > 0
    ? parts.join(", ")
    : t("catalog.features.sourceObservations.ui.list.bulk.promote.all.scope.all");
}

function formatPromotionScope(scope: SourceObservationPromotionScope): string {
  return formatReapplyScope({
    search: scope.search ?? "",
    status: scope.status ?? "",
    provider: scope.provider ?? "",
    language: scope.language ?? "",
    setId: scope.setId ?? "",
  });
}

function formatIntegrationJobScope(scope: SourceObservationIntegrationJobScope): string {
  const parts = Object.entries(scope)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key}: ${value}`);

  return parts.length > 0 ? parts.join(", ") : "All provider scopes";
}

function addIntegrationJobCompletionToast(
  action: "import" | "reapply",
  result: SourceObservationIntegrationJobResult,
  addToast: (message: string, tone: "success" | "warning" | "danger") => void,
) {
  if (action === "import") {
    addToast(
      t("catalog.features.sourceObservations.ui.integrations.import.completed", {
        imported: String(result.imported),
        observed: String(result.observed),
        failed: String(result.failed),
      }),
      result.failed > 0 ? "warning" : "success",
    );
    return;
  }

  addToast(
    t("catalog.features.sourceObservations.ui.integrations.reapply.completed", {
      reapplied: String(result.reapplied),
      skipped: String(result.skipped),
      failed: String(result.failed),
    }),
    result.failed > 0 ? "warning" : "success",
  );
}
