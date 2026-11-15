export type OperatorEvidenceIdentity = {
  sourceHead: string;
  checkoutHead: string;
  runId: string;
  runAttempt: string;
  job: string;
  jobIndex: string;
  suite: "tcgplayer_operator_extension";
};
export type OperatorEvidenceGitResult = {
  status: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};
export type OperatorEvidenceGitRunner = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; windowsHide: boolean; maxBuffer: number },
) => OperatorEvidenceGitResult | undefined;
export function operatorEvidenceIdentity(
  root: string,
  env?: NodeJS.ProcessEnv,
  options?: { runGit?: OperatorEvidenceGitRunner },
): OperatorEvidenceIdentity;
export function operatorFileInventory(directory: string): Record<string, string>;
export function scanOperatorPayload(bytes: Buffer): { cookieMarkers: number; grantMarkers: number };
