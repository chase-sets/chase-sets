import type { ConnectorLivenessAuthority } from "../../connector-feed/domain/liveness";
import type { ChannelHealthObservation, ChannelHealthReasonGeneration } from "./contracts";

export type ConnectorLivenessSeries = readonly ["connector-liveness", string, string, number, string];

export function connectorLivenessSeries(authority: ConnectorLivenessAuthority): string {
  return JSON.stringify([
    "connector-liveness",
    authority.connectionId,
    authority.livePairingId,
    authority.heartbeatRevision,
    authority.servedPolicyIdentity,
  ]);
}

export function evaluateConnectorLiveness(
  input: Readonly<{
    authority: ConnectorLivenessAuthority | null;
    openGeneration: ChannelHealthReasonGeneration | null;
    now: string;
    policyRevision: string;
    evaluationGeneration: number;
  }>,
): ChannelHealthObservation | null {
  const { authority, openGeneration, now, policyRevision, evaluationGeneration } = input;
  if (!authority) return null;
  if (authority.connectionStatus !== "active" && authority.connectionStatus !== "pending-setup") return null;
  const base = {
    schemaVersion: "ChannelHealthObservation/v1" as const,
    sourceKind: "connector-liveness" as const,
    reasonCode: "connector-liveness" as const,
    connectionId: authority.connectionId,
    policyRevision,
    evaluationGeneration,
  };
  if (openGeneration) {
    const series = JSON.parse(openGeneration.opening.sourceWorkId) as ConnectorLivenessSeries;
    const resultOrdinal =
      authority.livePairingId === null
        ? 4
        : authority.livePairingId !== openGeneration.fingerprint
          ? 3
          : authority.heartbeatRevision > series[3]
            ? 2
            : null;
    if (resultOrdinal === null) return null;
    return {
      ...base,
      sourceWorkId: openGeneration.opening.sourceWorkId,
      sourceAttempt: openGeneration.opening.sourceAttempt,
      resultOrdinal,
      fingerprint: openGeneration.fingerprint,
      outcome: "success",
      occurredAt: openGeneration.opening.occurredAt,
    };
  }
  if (
    authority.connectionStatus !== "active" ||
    authority.livePairingId === null ||
    authority.lastSeenAt === null ||
    authority.servedPollWindowSeconds === null ||
    authority.servedPolicyIdentity === null
  )
    return null;
  const windowMs = authority.servedPollWindowSeconds * 1000;
  const sourceAttempt = Math.floor((Date.parse(now) - Date.parse(authority.lastSeenAt)) / windowMs);
  if (sourceAttempt < 1) return null;
  return {
    ...base,
    sourceWorkId: connectorLivenessSeries(authority),
    sourceAttempt,
    resultOrdinal: 1,
    fingerprint: authority.livePairingId,
    outcome: "failure",
    occurredAt: new Date(Date.parse(authority.lastSeenAt) + sourceAttempt * windowMs).toISOString(),
  };
}
