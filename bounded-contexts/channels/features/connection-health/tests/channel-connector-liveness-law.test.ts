import { describe, expect, it } from "vitest";
import type { ConnectorLivenessAuthority } from "../../connector-feed/domain/liveness";
import { decodeChannelHealthObservation, decodeReasonGeneration } from "../domain/codecs";
import { connectorLivenessSeries, evaluateConnectorLiveness } from "../domain/connector-liveness";
import { channelHealthPolicy } from "../domain/policy";
import { observeReason, rollupHealth } from "../domain/reducer";
import { channelHealthReasons, type ChannelHealthReasonGeneration } from "../domain/contracts";

const lastSeenAt = "2026-10-07T12:00:00.000Z";
const due = "2026-10-07T12:01:00.000Z";
const authority: ConnectorLivenessAuthority = {
  connectionId: "connection_liveness",
  connectionStatus: "active",
  authorityGeneration: 1,
  livePairingId: "pair_first",
  heartbeatRevision: 1,
  lastSeenAt,
  servedPollWindowSeconds: 60,
  servedPolicyIdentity: "a".repeat(64),
  heartbeatDueAt: due,
};
const input = { authority, openGeneration: null, now: due, policyRevision: "b".repeat(64), evaluationGeneration: 1 };
const failure = evaluateConnectorLiveness(input)!;
const open = observeReason(undefined, failure, 1, channelHealthPolicy.defaultValue);

describe("channel-connector-liveness-law", () => {
  it("kills off-by-one-window, attempt-in-sourceWorkId and backfill mutants", () => {
    expect(evaluateConnectorLiveness({ ...input, now: "2026-10-07T12:00:59.999Z" })).toBeNull();
    expect(failure).toEqual({
      schemaVersion: "ChannelHealthObservation/v1",
      sourceKind: "connector-liveness",
      reasonCode: "connector-liveness",
      connectionId: authority.connectionId,
      sourceWorkId: JSON.stringify(["connector-liveness", authority.connectionId, "pair_first", 1, "a".repeat(64)]),
      fingerprint: "pair_first",
      sourceAttempt: 1,
      resultOrdinal: 1,
      outcome: "failure",
      occurredAt: due,
      policyRevision: input.policyRevision,
      evaluationGeneration: 1,
    });
    expect(evaluateConnectorLiveness({ ...input, now: "2026-10-07T12:02:30.000Z" })).toEqual({
      ...failure,
      sourceAttempt: 2,
      occurredAt: "2026-10-07T12:02:00.000Z",
    });
    expect(evaluateConnectorLiveness(input)).toEqual(failure);
    expect(decodeChannelHealthObservation(failure)).toEqual(failure);
    expect(decodeReasonGeneration(open)).toEqual(open);
  });

  it("closes only the retained opening tuple, with removed > superseded > resumed precedence", () => {
    for (const [livePairingId, ordinal] of [
      ["pair_first", 2],
      ["pair_second", 3],
      [null, 4],
    ] as const) {
      const changed = {
        ...authority,
        livePairingId,
        heartbeatRevision: 9,
        lastSeenAt: "2026-10-07T13:00:00.000Z",
        servedPolicyIdentity: "c".repeat(64),
      };
      const expected = { ...failure, outcome: "success", resultOrdinal: ordinal };
      expect(evaluateConnectorLiveness({ ...input, authority: changed, openGeneration: open })).toEqual(expected);
      expect(
        evaluateConnectorLiveness({
          ...input,
          authority: changed,
          openGeneration: open,
          now: "2030-01-01T00:00:00.000Z",
        }),
      ).toEqual(expected);
    }
  });

  it("is total over missing, unpaired, unserved and complete authority and all steady states", () => {
    const unserved = {
      ...authority,
      lastSeenAt: null,
      servedPollWindowSeconds: null,
      servedPolicyIdentity: null,
      heartbeatDueAt: null,
    };
    for (const candidate of [null, { ...unserved, livePairingId: null }, unserved])
      for (const now of [lastSeenAt, due, "2026-10-07T13:00:00.000Z"])
        expect(evaluateConnectorLiveness({ ...input, authority: candidate, now })).toBeNull();
    for (const now of [lastSeenAt, due, "2030-01-01T00:00:00.000Z"])
      expect(evaluateConnectorLiveness({ ...input, openGeneration: open, now })).toBeNull();
    for (const connectionStatus of ["paused", "disconnected"] as const)
      for (const openGeneration of [null, open])
        expect(
          evaluateConnectorLiveness({
            ...input,
            authority: { ...authority, connectionStatus, livePairingId: null },
            openGeneration,
          }),
        ).toBeNull();
    expect(evaluateConnectorLiveness({ ...input, authority: null, openGeneration: open })).toBeNull();
    expect(
      evaluateConnectorLiveness({
        ...input,
        authority: { ...unserved, livePairingId: "pair_second" },
        openGeneration: open,
      })?.resultOrdinal,
    ).toBe(3);
    expect(
      evaluateConnectorLiveness({ ...input, authority: { ...unserved, livePairingId: null }, openGeneration: open })
        ?.resultOrdinal,
    ).toBe(4);
    expect(
      evaluateConnectorLiveness({ ...input, authority: { ...authority, connectionStatus: "pending-setup" } }),
    ).toBeNull();
  });

  it("kills tuple-threshold-applied and success-reuses-ordinal-1; a later series gets fresh attention", () => {
    expect(open.state).toBe("failing");
    expect(rollupHealth([open])).toBe("failing");
    const nextAuthority = { ...authority, heartbeatRevision: 2 };
    const success = evaluateConnectorLiveness({ ...input, authority: nextAuthority, openGeneration: open })!;
    expect(success.resultOrdinal).toBe(2);
    const closed = observeReason(open, success, 1, channelHealthPolicy.defaultValue);
    expect(closed.state).toBe("closed");
    const nextFailure = evaluateConnectorLiveness({ ...input, authority: nextAuthority })!;
    expect(nextFailure.sourceWorkId).not.toBe(failure.sourceWorkId);
    expect(nextFailure.sourceAttempt).toBe(1);
    expect(observeReason(closed, nextFailure, 1, channelHealthPolicy.defaultValue).generation).toBe(2);
    const ordinary = channelHealthReasons
      .filter((reason) => reason !== "connector-liveness")
      .map((reasonCode) => ({ ...closed, reasonCode }));
    expect(rollupHealth(ordinary)).toBe("healthy");
  });

  it("rejects aliased, cross-connection and cross-pairing series without relaxing other producers", () => {
    for (const patch of [
      { sourceWorkId: "a".repeat(64) },
      { sourceWorkId: connectorLivenessSeries({ ...authority, connectionId: "other" }) },
      { fingerprint: "pair_other" },
      { sourceWorkId: JSON.stringify(["connector-liveness", authority.connectionId, "pair_first", 0, "a".repeat(64)]) },
    ])
      expect(() => decodeChannelHealthObservation({ ...failure, ...patch })).toThrow("invalid-health-contract");
    expect(() =>
      decodeChannelHealthObservation({ ...failure, reasonCode: "polling", sourceKind: "polling" }),
    ).toThrow();
    expect(decodeReasonGeneration(open as ChannelHealthReasonGeneration)).toEqual(open);
  });
});
