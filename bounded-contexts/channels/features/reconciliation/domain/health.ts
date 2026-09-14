import { createHash } from "node:crypto";
import type { ChannelDriftClassification, ChannelHealthObservationV1, ChannelSourceAuthority } from "./contracts";

export function mapChannelDriftToHealthObservation(
  input: Readonly<{
    connectionId: string;
    runGeneration: number;
    sourceAttempt: number;
    resultOrdinal: number;
    policyRevision: string;
    evaluationGeneration: number;
    classification: ChannelDriftClassification;
    sourceAuthority: ChannelSourceAuthority;
    materialFingerprint: string;
    occurredAt: string;
  }>,
): ChannelHealthObservationV1 | null {
  if (input.sourceAuthority.kind === "absent-by-design") return null;
  const outcome = input.classification === "in-sync" ? "success" : "failure";
  return Object.freeze({
    schemaVersion: "ChannelHealthObservation/v1",
    sourceKind: "channel-reconciliation",
    sourceWorkId: boundedDigest(
      `channel-reconciliation\0${input.connectionId}\0${input.runGeneration}\0${input.policyRevision}`,
    ),
    sourceAttempt: input.sourceAttempt,
    resultOrdinal: input.resultOrdinal,
    policyRevision: input.policyRevision,
    evaluationGeneration: input.evaluationGeneration,
    connectionId: input.connectionId,
    reasonCode: "drift",
    fingerprint: input.materialFingerprint,
    outcome,
    occurredAt: input.occurredAt,
  });
}

function boundedDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
