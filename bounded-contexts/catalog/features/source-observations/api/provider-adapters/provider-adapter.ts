import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogProviderCredentialReadiness } from "../governance/catalog-integration-credential-readiness";
import type {
  CatalogAliasReviewStateKey,
  CatalogAliasSourceCategoryKey,
  CatalogAliasTypeKey,
} from "../governance/catalog-integration-data-governance";
import type { CatalogAliasConfidenceKey } from "../../../alias-equivalence/domain/alias";

export type CatalogIntegrationUnitDescriptor = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose?: string;
  displayName: string;
  profileVersion?: string;
}>;

export type ProviderAdapterCapabilities = Readonly<{
  supportsOptionQueries: boolean;
  supportsImportPlanning: boolean;
  supportsPayloadFetch: boolean;
}>;

export type ProviderOptionQueryInput = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  optionKind: string;
  parentValues?: Readonly<Record<string, string>>;
}>;

/**
 * A typed equivalence-name alias for a provider option, using the shared Catalog
 * Alias vocabulary rather than untyped label metadata. Scope selection
 * is pre-import, so these aliases come from provider option queries / provider
 * English endpoints rather than durable Catalog Alias candidates; they share the
 * vocabulary and extraction logic but are a distinct, pre-import data path.
 *
 * `metadata` on the option stays for non-semantic display/transport only
 * (logo/symbol URL, card count, etc.). The semantic "what does this option mean
 * in English" signal lives here, typed.
 */
export type ProviderOptionAlias = Readonly<{
  /** The alias text, e.g. the English equivalent of a localized set name. */
  aliasText: string;
  /** Language of the alias text (e.g. "en"). */
  aliasLanguageCode: string;
  aliasType: CatalogAliasTypeKey;
  /** Trust marking, orthogonal to alias type. */
  confidence: CatalogAliasConfidenceKey;
  /** Governed review status; pre-import aliases are evidence held for review. */
  reviewStatus: CatalogAliasReviewStateKey;
  /** Source category that produced the alias, per the governance policy. */
  sourceCategory: CatalogAliasSourceCategoryKey;
  /** Supporting evidence (e.g. shared provider id) backing the alias. */
  evidence?: JsonObject;
}>;

export type ProviderOptionItem = Readonly<{
  value: string;
  label: string;
  parentValue?: string;
  /** Typed equivalence aliases for the option, sharing the Catalog Alias vocabulary. */
  aliases?: readonly ProviderOptionAlias[];
  /** Non-semantic display/transport metadata only (logo URL, card count, etc.). */
  metadata?: Readonly<Record<string, string>>;
}>;

export type ProviderOptionQueryResult = Readonly<{
  items: readonly ProviderOptionItem[];
  nextCursor?: string;
}>;

export type ProviderImportScope = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  scopeKey: string;
  values: Readonly<Record<string, string>>;
}>;

export type ProviderUsageEstimate = Readonly<{
  requestStrategy: "bulk-first" | "single-record" | "unknown";
  estimateState: "estimated" | "estimate-unavailable";
  estimatedRequestCount: number | null;
  estimateReason: string | null;
  pageSize: number | null;
  selectedFields: readonly string[];
  perRecordFallbackReason: string | null;
  usageCheckState: "checked" | "not-supported" | "not-configured" | "unavailable" | "unknown";
  creditDiagnostic: string | null;
  degradedDiagnostic: string | null;
}>;

export type ProviderImportPlan = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  planKey: string;
  scope: ProviderImportScope;
  estimatedPayloads?: number;
  transportSteps: readonly string[];
  usageEstimate?: ProviderUsageEstimate;
}>;

export type ProviderPayloadFetchProgress = Readonly<{
  phase: "fetching";
  completed: number;
  total: number;
  currentLabel: string | null;
}>;

export type ProviderPayloadFetchOptions = Readonly<{
  onProgress?: (progress: ProviderPayloadFetchProgress) => void | Promise<void>;
}>;

export type ProviderPayloadProvenance = Readonly<{
  sourceUrl?: string;
  sourceUpdatedAt?: string;
  fetchedAt: string;
  contentHash?: string;
}>;

export type ProviderPayloadEnvelope<TPayload = unknown> = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  externalKey: string;
  payload: TPayload;
  provenance: ProviderPayloadProvenance;
}>;

export type ProviderTransportDiagnostic = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  unitKey?: CatalogIntegrationUnitKey;
  retryAfterSeconds?: number;
}>;

export type ProviderAdapter<TPayload = unknown> = Readonly<{
  providerKey: string;
  capabilities: ProviderAdapterCapabilities;
  listIntegrationUnits(): Promise<readonly CatalogIntegrationUnitDescriptor[]>;
  listOptions(input: ProviderOptionQueryInput): Promise<ProviderOptionQueryResult>;
  planImport(scope: ProviderImportScope): Promise<ProviderImportPlan>;
  fetchPayloads(
    plan: ProviderImportPlan,
    options?: ProviderPayloadFetchOptions,
  ): AsyncIterable<ProviderPayloadEnvelope<TPayload>>;
  getCredentialReadiness(): Promise<readonly CatalogProviderCredentialReadiness[]>;
  getTransportDiagnostics(): Promise<readonly ProviderTransportDiagnostic[]>;
}>;
