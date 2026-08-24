export declare const PRIVACY_PRODUCT_TRUTH_INVENTORY_VERSION: string;

export declare const privacyProductTruthFactFamilies: readonly string[];

export declare const privacyProductTruthExclusionReasons: readonly string[];

export declare const defaultConsumerDeployables: readonly string[];

export type PrivacyProductTruthExecGit = (args: readonly string[]) => string;

export type PrivacyProductTruthSourceRecord = Readonly<{
  relativePath: string;
  source?: string;
  readError?: string;
}>;

export type PrivacyProductTruthPartitionExclusion = Readonly<{
  relativePath: string;
  reason: string;
}>;

export type PrivacyProductTruthSources = Readonly<{
  trackedPaths: readonly string[];
  candidates: readonly string[];
  excluded: readonly PrivacyProductTruthPartitionExclusion[];
  records: readonly PrivacyProductTruthSourceRecord[];
  repoRoot: string;
}>;

export type PrivacyProductTruthExternalPackageClassification = Readonly<{
  kind: "client-script-loader" | "bundled-library";
  reason?: string;
  scriptOrigins?: readonly string[];
}>;

export type PrivacyProductTruthFact = Readonly<{
  factFamily: string;
  subject: string;
  evidenceRefs: readonly string[];
  derivationShapes: readonly string[];
  trackedGeneratedDerived: boolean;
  detail: Readonly<Record<string, unknown>>;
}>;

export type PrivacyProductTruthIndeterminate = Readonly<{
  factFamily: string;
  reason: string;
}>;

export type PrivacyProductTruthPartitionTotals = Readonly<{
  trackedTotal: number;
  candidateTotal: number;
  scannedTotal: number;
  trackedGeneratedTotal: number;
  readFailureTotal: number;
  parseFailureTotal: number;
  excludedTotal: number;
  excludedByReason: Readonly<Record<string, number>>;
}>;

export type PrivacyProductTruthInventoryResult = Readonly<{
  version: string;
  partition: PrivacyProductTruthPartitionTotals;
  facts: readonly PrivacyProductTruthFact[];
  indeterminate: readonly PrivacyProductTruthIndeterminate[];
  readFailures: readonly Readonly<{ relativePath: string; reason: string }>[];
  trackedGeneratedFiles: readonly string[];
  observedExternalPackages: readonly string[];
  cspScriptOrigins: readonly string[];
  consumerRouteModuleTotal: number;
  sourceDigest: string;
}>;

export type PrivacyProductTruthDerivationInput = Readonly<{
  records: readonly PrivacyProductTruthSourceRecord[];
  trackedPaths: readonly string[];
  excluded?: readonly PrivacyProductTruthPartitionExclusion[];
  repoRoot: string;
  externalPackageClassifications?: Readonly<Record<string, PrivacyProductTruthExternalPackageClassification>>;
  consumerDeployables?: readonly string[];
}>;

export type PrivacyProductTruthCollectOptions = Readonly<{
  repoRoot: string;
  execGit?: PrivacyProductTruthExecGit;
  externalPackageClassifications?: Readonly<Record<string, PrivacyProductTruthExternalPackageClassification>>;
  consumerDeployables?: readonly string[];
}>;

export type PrivacyCitedSourceBinding = Readonly<{
  factId: string;
  classification: Readonly<{ noticeBoundary: string; factFamily: string }>;
  inventorySubject: string;
  evidenceRefs: readonly string[];
  factualSummary: string;
  disclosures: readonly Readonly<{ sectionId: string; requiredTokens: readonly string[] }>[];
}>;

export type PrivacyCitedSourceSlice = Readonly<{
  ref: string;
  relativePath?: string;
  start?: number;
  end?: number;
  text?: string;
  error?: string;
}>;

export declare function classifyPrivacyProductTruthPartitionExclusion(relativePath: string): string | null;

export declare function isPrivacyProductTruthCandidateModule(relativePath: string): boolean;

export declare function listPrivacyProductTruthTrackedPaths(
  repoRoot: string,
  options?: Readonly<{ execGit?: PrivacyProductTruthExecGit }>,
): readonly string[];

export declare function partitionPrivacyProductTruthPaths(trackedPaths: readonly string[]): Readonly<{
  trackedPaths: readonly string[];
  candidates: readonly string[];
  excluded: readonly PrivacyProductTruthPartitionExclusion[];
}>;

export declare function readPrivacyProductTruthSources(
  options: Readonly<{ repoRoot: string; execGit?: PrivacyProductTruthExecGit }>,
): PrivacyProductTruthSources;

export declare function derivePrivacyProductTruthInventory(
  input: PrivacyProductTruthDerivationInput,
): PrivacyProductTruthInventoryResult;

export declare function collectPrivacyProductTruthInventory(
  options: PrivacyProductTruthCollectOptions,
): PrivacyProductTruthInventoryResult;

export declare function readCitedSourceSlice(repoRoot: string, ref: string): PrivacyCitedSourceSlice;

export declare function computePrivacyCitedSourceDigest(
  repoRoot: string,
  bindings: readonly PrivacyCitedSourceBinding[],
): string;
