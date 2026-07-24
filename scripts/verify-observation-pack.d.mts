export function runVerifyObservationPackCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: Readonly<{ write(value: string): unknown }>,
  dependencies?: Readonly<{
    fetch?: typeof globalThis.fetch;
    verifyPostReplay?: (input: unknown) => Promise<unknown>;
    verifyCommercePackCohort?: (input: unknown) => Promise<Readonly<Record<string, unknown>>>;
  }>,
): Promise<number>;

export function verifyPostReplay(input: Readonly<Record<string, unknown>>): Promise<unknown>;

export function verifyCommercePackCohort(input: Readonly<Record<string, unknown>>): Promise<unknown>;

export function buildClosedCommercePackCohortEvidence(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;

export function buildCanonicalRepresentativeDatabaseIdentity(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>;

export function assertRepresentativeCommerceProjectionClosure(input: Readonly<Record<string, unknown>>): void;

export function assertDayAfterCommerceClosure(
  prior: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  replayReceipt: Readonly<Record<string, unknown>>,
): void;

export function buildCommercePackCohortEvidence(
  input: Readonly<{
    commerceCatalogItemIds: readonly string[];
    catalogReferences: readonly Readonly<{
      catalogItemId: string;
      providerKey: string;
      externalKey: string;
    }>[];
    acceptedPackReferences: readonly Readonly<{ providerKey: string; externalKey: string }>[];
    minimumPercentage?: number;
  }>,
): Readonly<{
  command: "verify-commerce-pack-cohort";
  status: "verified" | "blocked";
  numerator: number;
  denominator: number;
  percentage: number;
  minimumPercentage: number;
  unmatchedSampleCatalogItemIds: readonly string[];
}>;

export function buildPostReplayVerifierEvidence(
  input: Readonly<{
    externalReferenceDigest: string;
    counts: Readonly<Record<string, number>>;
    perTableRowCounts: readonly Readonly<{ table: string; rowCount: string }>[];
  }>,
): Readonly<{
  verifierDigest: string;
  externalReferenceDigest: string;
  counts: Readonly<Record<string, number>>;
  perTableRowCounts: readonly Readonly<{ table: string; rowCount: string }>[];
}>;
