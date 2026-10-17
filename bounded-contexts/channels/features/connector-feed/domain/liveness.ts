import { channelConnectionStatuses, type ChannelConnectionStatus } from "../../connections/domain/contracts";
import {
  assertClosedRecord,
  assertOpaqueId,
  assertRfc3339Instant,
  assertSafeInteger,
} from "../../connections/domain/validation";

export type ConnectorLivenessAuthority = Readonly<{
  connectionId: string;
  connectionStatus: ChannelConnectionStatus;
  authorityGeneration: number;
  livePairingId: string | null;
  heartbeatRevision: number;
  lastSeenAt: string | null;
  servedPollWindowSeconds: number | null;
  servedPolicyIdentity: string | null;
  heartbeatDueAt: string | null;
}>;
export type ConnectorLivenessRead = Readonly<{ connectionId: string }>;
export type ConnectorLivenessCursor = Readonly<{ heartbeatDueAt: string; connectionId: string }>;
export type ConnectorLivenessCandidates = Readonly<{ dueAt: string; limit: number; after?: ConnectorLivenessCursor }>;
export type ConnectorLivenessPage = Readonly<{
  candidates: readonly ConnectorLivenessAuthority[];
  nextCursor: ConnectorLivenessCursor | null;
}>;

export function assertConnectorLivenessAuthority(value: unknown): asserts value is ConnectorLivenessAuthority {
  assertClosedRecord(
    value,
    [
      "connectionId",
      "connectionStatus",
      "authorityGeneration",
      "livePairingId",
      "heartbeatRevision",
      "lastSeenAt",
      "servedPollWindowSeconds",
      "servedPolicyIdentity",
      "heartbeatDueAt",
    ],
    "connector liveness authority",
  );
  assertOpaqueId(value.connectionId, "connectionId");
  if (!channelConnectionStatuses.includes(value.connectionStatus as ChannelConnectionStatus))
    throw new Error("invalid-connection-status");
  assertSafeInteger(value.authorityGeneration, "authorityGeneration");
  if (value.authorityGeneration < 1) throw new Error("invalid-authority-generation");
  assertSafeInteger(value.heartbeatRevision, "heartbeatRevision");
  if (value.livePairingId !== null) assertOpaqueId(value.livePairingId, "livePairingId");
  const heartbeat = [value.lastSeenAt, value.servedPollWindowSeconds, value.servedPolicyIdentity, value.heartbeatDueAt];
  if (heartbeat.every((field) => field === null)) return;
  if (value.livePairingId === null || value.heartbeatRevision === 0) throw new Error("invalid-unpaired-heartbeat");
  assertRfc3339Instant(value.lastSeenAt);
  assertRfc3339Instant(value.heartbeatDueAt);
  const window = value.servedPollWindowSeconds;
  if (typeof window !== "number" || !Number.isInteger(window) || window < 1 || window > 3600)
    throw new Error("invalid-poll-window");
  if (typeof value.servedPolicyIdentity !== "string" || !/^[0-9a-f]{64}$/.test(value.servedPolicyIdentity))
    throw new Error("invalid-served-policy-identity");
  if (Date.parse(value.heartbeatDueAt) !== Date.parse(value.lastSeenAt) + window * 1000)
    throw new Error("invalid-heartbeat-due-at");
}

export function assertConnectorLivenessRead(input: ConnectorLivenessRead): void {
  assertClosedRecord(input, ["connectionId"], "connector liveness read");
  assertOpaqueId(input.connectionId, "connectionId");
}

export function assertConnectorLivenessCandidates(input: ConnectorLivenessCandidates): void {
  assertClosedRecord(input, ["dueAt", "limit", "after"], "connector liveness candidates");
  assertRfc3339Instant(input.dueAt);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new Error("invalid-candidate-limit");
  if (input.after !== undefined) {
    assertClosedRecord(input.after, ["heartbeatDueAt", "connectionId"], "connector liveness cursor");
    assertRfc3339Instant(input.after.heartbeatDueAt);
    assertOpaqueId(input.after.connectionId, "connectionId");
  }
}
