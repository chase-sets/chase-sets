export type BootstrapDbExecutionUnitName = `test:db:${number}`;

export interface BootstrapDbEnrollmentCase {
  readonly name: string;
  /** Per-case duration from the hosted job named in `bootstrapDbScheduleModel`. */
  readonly referenceDurationMs: number;
  /** Digest of the case's parsed arguments after its name; see the guard module. */
  readonly identity: string;
}

export interface BootstrapDbEnrollmentPartition {
  readonly executionUnit: BootstrapDbExecutionUnitName;
  readonly databaseSuffix: string;
  readonly bootBearingCases: "all" | readonly string[];
  readonly cases: readonly BootstrapDbEnrollmentCase[];
}

export interface BootstrapDbScheduleModel {
  readonly referenceRunId: number;
  readonly referenceJobId: number;
  readonly referenceJobName: string;
  readonly referenceHeadSha: string;
  readonly referenceEvent: string;
  readonly maxWorkersPerExecutionUnit: number;
  readonly testFileFixedCostMs: number;
  readonly executionUnitFixedCostMs: number;
  readonly jobOverheadMs: number;
  readonly executionUnitCeilingMs: number;
  readonly aggregateCeilingMs: number;
  readonly maximumCaseReferenceDurationMs: number;
  readonly maximumScheduledFileCount: number;
  readonly maximumEnumeratedUnitCount: number;
}

export interface BootstrapDbScheduledFile {
  readonly fileName: string;
  readonly executionUnit: BootstrapDbExecutionUnitName;
  readonly caseCount: number;
  readonly caseDurationMs: number;
  readonly durationMs: number;
}

export interface BootstrapDbScheduledUnit {
  readonly scriptName: BootstrapDbExecutionUnitName;
  readonly fileNames: readonly string[];
  readonly makespanMs: number;
  readonly bootBearingCaseCount: number;
  readonly bootBearingCeiling: number | null;
}

export interface BootstrapDbScheduleAlternative {
  readonly unitCount: number;
  readonly units: readonly Readonly<{ fileNames: readonly string[]; makespanMs: number }>[];
}

export interface BootstrapDbSchedule {
  readonly units: readonly BootstrapDbScheduledUnit[];
  readonly files: readonly BootstrapDbScheduledFile[];
  readonly observedUnitCount: number;
  readonly minimumUnitCount: number | null;
  readonly aggregateMs: number;
  readonly aggregateWithOverheadMs: number;
  readonly oneFewerUnit: BootstrapDbScheduleAlternative | null;
}

export interface BootstrapDbEnrollmentResult {
  readonly caseCount: number;
  readonly expectedCaseCount: number;
  readonly fileCount: number;
  readonly inspectedFiles: readonly string[];
  readonly partitionUnitCount: number;
  readonly caseIdentities: Readonly<Record<string, string | null>>;
  readonly schedule: BootstrapDbSchedule;
  readonly violations: readonly string[];
}

export const bootstrapDbEnrollmentManifest: Readonly<Record<string, BootstrapDbEnrollmentPartition>>;
export const bootstrapDbExecutionUnitBootBearingCaseCeilings: Readonly<Record<BootstrapDbExecutionUnitName, number>>;
export const bootstrapDbScheduleModel: BootstrapDbScheduleModel;

export function checkBootstrapDbEnrollment(
  options?: Readonly<{
    platformApiRoot?: string;
    manifest?: Readonly<Record<string, BootstrapDbEnrollmentPartition>>;
    executionUnitBootBearingCaseCeilings?: Readonly<Record<string, number>>;
    /** Untrusted input validated against the closed JSON-like plain-record contract before use. */
    scheduleModel?: unknown;
  }>,
): BootstrapDbEnrollmentResult;

export function deriveBootstrapDbCaseIdentities(
  fileName: string,
  source: string,
): readonly Readonly<{ name: string; identity: string }>[];

export function formatBootstrapDbEnrollmentResult(result: BootstrapDbEnrollmentResult): string;
