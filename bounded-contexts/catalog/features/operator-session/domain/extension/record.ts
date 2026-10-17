import {
  closed,
  isEnvironment,
  isGrant,
  isInstant,
  operatorOutcomes,
  operatorStates,
  safeInteger,
  type OperatorEnvironment,
  type OperatorOutcome,
  type OperatorState,
} from "./protocol";

export type OperatorRecord = {
  schemaVersion: 1;
  environment: OperatorEnvironment;
  grant: string | null;
  lastRevision: number;
  profileRevision: number;
  state: Exclude<OperatorState, "upgrade-required">;
  nextAttemptAt: number;
  dirty: boolean;
  staleRetries: number;
  lastPushedAt: string | null;
  lastOutcome: OperatorOutcome | null;
};
export const operatorRecordKey = (environment: OperatorEnvironment) => `catalog.operator-session.${environment}`;
export function emptyOperatorRecord(environment: OperatorEnvironment): OperatorRecord {
  return {
    schemaVersion: 1,
    environment,
    grant: null,
    lastRevision: 0,
    profileRevision: 0,
    state: "unpaired",
    nextAttemptAt: 0,
    dirty: false,
    staleRetries: 0,
    lastPushedAt: null,
    lastOutcome: null,
  };
}
export function isOperatorRecord(value: unknown, environment: OperatorEnvironment): value is OperatorRecord {
  return (
    closed(value, [
      "schemaVersion",
      "environment",
      "grant",
      "lastRevision",
      "profileRevision",
      "state",
      "nextAttemptAt",
      "dirty",
      "staleRetries",
      "lastPushedAt",
      "lastOutcome",
    ]) &&
    value.schemaVersion === 1 &&
    isEnvironment(value.environment) &&
    value.environment === environment &&
    (value.grant === null || isGrant(value.grant)) &&
    safeInteger(value.lastRevision) &&
    safeInteger(value.profileRevision) &&
    value.state !== "upgrade-required" &&
    operatorStates.some((state) => state === value.state) &&
    safeInteger(value.nextAttemptAt) &&
    typeof value.dirty === "boolean" &&
    safeInteger(value.staleRetries) &&
    value.staleRetries <= 3 &&
    (value.lastPushedAt === null || isInstant(value.lastPushedAt)) &&
    (value.lastOutcome === null || operatorOutcomes.some((outcome) => outcome === value.lastOutcome)) &&
    (value.grant === null
      ? (value.state === "unpaired" || value.state === "re-pair-required") && !value.dirty
      : value.state !== "unpaired" && value.state !== "re-pair-required")
  );
}
