import type { CatalogIntegrationUnitKey } from "../integration-unit";
import type { CatalogProviderCredentialReadiness } from "../catalog-integration-credential-readiness";

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

export type ProviderOptionItem = Readonly<{
  value: string;
  label: string;
  parentValue?: string;
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

export type ProviderImportPlan = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  planKey: string;
  scope: ProviderImportScope;
  estimatedPayloads?: number;
  transportSteps: readonly string[];
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
