export type BootstrapDbWorkloadSection =
  | "W1 case identities"
  | "W1 census"
  | "W1 file"
  | "W1 partition"
  | "W2 file"
  | "W3 file"
  | "W3 json"
  | "W3 selection"
  | "W4 alias"
  | "W4 postgres"
  | "W4 unit"
  | "W5 version";

/** `[section, member key, bound value]`, sorted by section then key. */
export type BootstrapDbWorkloadBinding = readonly [BootstrapDbWorkloadSection, string, unknown];

export interface BootstrapDbWorkloadDerivation {
  readonly bindings: readonly BootstrapDbWorkloadBinding[];
  /** Every input that could not be read, resolved or bound; nonempty means refused. */
  readonly gaps: readonly string[];
  /** `[importer:line, target]` local modules members reach but the selectors leave opaque; audit only. */
  readonly frontier?: readonly (readonly [string, string])[];
}

export interface BootstrapDbWorkloadCaptureBinding {
  readonly fileName: string;
  readonly fixtureSha256: string;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface BootstrapDbWorkloadBaseline {
  readonly schema: string;
  readonly capture: Readonly<{
    fileName: string;
    fixtureSha256: string;
    runId: string;
    checkoutSha: string;
    sourceBase: string;
    captureParent: string;
  }>;
  readonly source: Readonly<{ commit: string; ref?: string; historicalBranch?: string; historicalHead?: string }>;
  readonly selectorsSha256: string;
  readonly bindingsSha256: string;
  readonly bindings: readonly BootstrapDbWorkloadBinding[];
}

export const bootstrapDbWorkloadSelectors: Readonly<Record<string, unknown>>;
export const bootstrapDbWorkloadSelectorsSha256: string;

export function canonicalJson(value: unknown): string;

export function deriveBootstrapDbWorkload(
  options?: Readonly<{ repositoryRoot?: string }>,
): Promise<BootstrapDbWorkloadDerivation>;

export function checkBootstrapDbWorkloadFreshness(
  options: Readonly<{
    /** Untrusted input validated against the baseline shape before use. */
    baseline: unknown;
    capture: BootstrapDbWorkloadCaptureBinding | undefined;
    derivation: BootstrapDbWorkloadDerivation | undefined;
  }>,
): Readonly<{ violations: readonly string[] }>;

export function bindFrozenSourceToCapture(
  options: Readonly<{ capture: unknown; readSourceFile: (path: string) => Uint8Array | null }>,
): Readonly<{ violations: readonly string[] }>;

export function createBootstrapDbWorkloadBaseline(
  options: Readonly<{
    captureFileName: string;
    captureBytes: Uint8Array;
    source: BootstrapDbWorkloadBaseline["source"];
    derivation: BootstrapDbWorkloadDerivation;
  }>,
): BootstrapDbWorkloadBaseline;

export function formatBootstrapDbWorkloadBaseline(baseline: BootstrapDbWorkloadBaseline): string;
