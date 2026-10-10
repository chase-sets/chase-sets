import { closedRecord, connectorValue, utcInstant } from "../../connector-client/domain/extension-records";

export const stagedImportDispatchPolicyKey = "channels.tcgplayer-staged-import-dispatch";
export const stagedImportDispatchApplicability = "founder-staged-import-all-provider-requests";
export type TcgplayerStagedImportDispatchPolicy = Readonly<{ minimumRequestStartIntervalSeconds: number }>;
export class StagedImportDispatchError extends Error {
  constructor(
    readonly code:
      | "staged-import-policy-unavailable"
      | "staged-import-plan-unavailable"
      | "staged-import-fit-refused"
      | "staged-import-authority-refused"
      | "staged-import-outcome-unknown",
  ) {
    super(code);
  }
}

export function decodeStagedImportDispatchPolicy(input: unknown): TcgplayerStagedImportDispatchPolicy {
  try {
    const row = closedRecord(input, ["minimumRequestStartIntervalSeconds"]);
    const value = row.minimumRequestStartIntervalSeconds;
    if (!Number.isSafeInteger(value) || Number(value) < 60 || Number(value) > 600) throw new Error();
    return { minimumRequestStartIntervalSeconds: Number(value) };
  } catch {
    throw new StagedImportDispatchError("staged-import-policy-unavailable");
  }
}

export type StagedImportDispatchPolicyResponse = Readonly<{
  schemaVersion: 1;
  policyKey: typeof stagedImportDispatchPolicyKey;
  unit: "seconds";
  applicability: typeof stagedImportDispatchApplicability;
  connectionId: string;
  pairingId: string;
  reservationId: string;
  requestNonce: string;
  policy: Readonly<{
    source: "policy";
    documentId: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    resolvedAt: string;
    value: TcgplayerStagedImportDispatchPolicy;
    revision: string;
  }>;
}>;

export function decodeStagedImportDispatchPolicyResponse(input: unknown): StagedImportDispatchPolicyResponse {
  try {
    const row = closedRecord(input, [
      "schemaVersion",
      "policyKey",
      "unit",
      "applicability",
      "connectionId",
      "pairingId",
      "reservationId",
      "requestNonce",
      "policy",
    ]);
    if (
      row.schemaVersion !== 1 ||
      row.policyKey !== stagedImportDispatchPolicyKey ||
      row.unit !== "seconds" ||
      row.applicability !== stagedImportDispatchApplicability
    )
      throw new Error();
    for (const key of ["connectionId", "pairingId", "reservationId"]) connectorValue(row[key]);
    if (typeof row.requestNonce !== "string" || !/^[a-f0-9]{32}$/.test(row.requestNonce)) throw new Error();
    const policy = closedRecord(row.policy, [
      "source",
      "documentId",
      "effectiveFrom",
      "effectiveUntil",
      "resolvedAt",
      "value",
      "revision",
    ]);
    if (policy.source !== "policy") throw new Error();
    connectorValue(policy.documentId);
    if (
      !utcInstant(policy.effectiveFrom) ||
      !utcInstant(policy.resolvedAt) ||
      (policy.effectiveUntil !== null && !utcInstant(policy.effectiveUntil))
    )
      throw new Error();
    if (
      Date.parse(policy.effectiveFrom) > Date.parse(policy.resolvedAt) ||
      (policy.effectiveUntil !== null && Date.parse(policy.effectiveUntil as string) <= Date.parse(policy.resolvedAt))
    )
      throw new Error();
    if (typeof policy.revision !== "string" || !/^[a-f0-9]{64}$/.test(policy.revision)) throw new Error();
    decodeStagedImportDispatchPolicy(policy.value);
    return structuredClone(row) as StagedImportDispatchPolicyResponse;
  } catch {
    throw new StagedImportDispatchError("staged-import-policy-unavailable");
  }
}
