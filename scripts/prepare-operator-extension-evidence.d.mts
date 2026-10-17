export type OperatorEvidenceIdentity = {
  sourceHead: string;
  checkoutHead: string;
  runId: string;
  runAttempt: string;
  job: string;
  jobIndex: string;
  suite: "tcgplayer_operator_extension";
};
export function operatorEvidenceIdentity(root: string, env?: NodeJS.ProcessEnv): OperatorEvidenceIdentity;
export function operatorFileInventory(directory: string): Record<string, string>;
export function scanOperatorPayload(bytes: Buffer): { cookieMarkers: number; grantMarkers: number };
