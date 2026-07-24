export interface BootstrapDbEnrollmentPartition {
  readonly databaseSuffix: string;
  readonly cases: readonly string[];
}

export interface BootstrapDbEnrollmentResult {
  readonly caseCount: number;
  readonly expectedCaseCount: number;
  readonly inspectedFiles: readonly string[];
  readonly violations: readonly string[];
}

export const bootstrapDbEnrollmentManifest: Readonly<Record<string, BootstrapDbEnrollmentPartition>>;

export function checkBootstrapDbEnrollment(
  options?: Readonly<{
    platformApiRoot?: string;
  }>,
): BootstrapDbEnrollmentResult;

export function formatBootstrapDbEnrollmentResult(result: BootstrapDbEnrollmentResult): string;
