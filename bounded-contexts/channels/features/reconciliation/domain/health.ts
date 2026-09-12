import { createHash } from "node:crypto";
import type { ChannelDriftClassification, ChannelHealthObservationV1, ChannelSourceAuthority } from "./contracts";

export function mapChannelDriftToHealthObservation(
  input: Readonly<{
    connectionId: string;
    runGeneration: number;
    sourceAttempt: number;
    resultOrdinal: number;
    policyRevision: number;
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
    fingerprint: boundedDigest(`${input.classification}\0${input.sourceAuthority.kind}\0${input.materialFingerprint}`),
    outcome,
    occurredAt: input.occurredAt,
  });
}

export function mapPersistentGapToHealthObservation(
  input: Readonly<{
    connectionId: string;
    runGeneration: number;
    sourceAttempt: number;
    resultOrdinal: number;
    policyRevision: number;
    evaluationGeneration: number;
    gapFingerprint: string;
    occurredAt: string;
  }>,
): ChannelHealthObservationV1 {
  return Object.freeze({
    sourceKind: "channel-reconciliation",
    sourceWorkId: boundedDigest(
      `channel-missed-sale-gap\0${input.connectionId}\0${input.runGeneration}\0${input.policyRevision}`,
    ),
    sourceAttempt: input.sourceAttempt,
    resultOrdinal: input.resultOrdinal,
    policyRevision: input.policyRevision,
    evaluationGeneration: input.evaluationGeneration,
    connectionId: input.connectionId,
    reasonCode: "drift",
    fingerprint: boundedDigest(`persistent-gap\0${input.gapFingerprint}`),
    outcome: "failure",
    occurredAt: input.occurredAt,
  });
}

function boundedDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
