import { describe, expect, it } from "vitest";
import {
  decodeChannelHealthChanged,
  decodeChannelHealthObservation,
  decodeChannelHealthPolicy,
  decodeChannelHealthQuery,
  decodeChannelHealthRead,
  decodeReasonGeneration,
} from "../domain/codecs";
import { deriveChannelHealthSourceWorkId, healthDigest } from "../domain/identity";
import { channelHealthPolicy } from "../domain/policy";

const hash = healthDigest("synthetic");
const observation = {
  schemaVersion: "ChannelHealthObservation/v1",
  sourceKind: "polling",
  sourceWorkId: hash,
  sourceAttempt: 1,
  resultOrdinal: 1,
  policyRevision: hash,
  evaluationGeneration: 1,
  connectionId: "connection_test",
  reasonCode: "polling",
  fingerprint: hash,
  outcome: "failure",
  occurredAt: "2026-09-12T12:00:00-05:00",
};
const reason = {
  reasonCode: "polling",
  generation: 1,
  fingerprint: hash,
  state: "degraded",
  consecutiveFailures: 1,
  trailingFailures: 1,
  opening: { sourceWorkId: hash, sourceAttempt: 1, occurredAt: observation.occurredAt },
  lastOccurredAt: observation.occurredAt,
};
const fact = {
  schemaVersion: "ChannelHealthChanged/v1",
  connection: { connectionId: "connection_test", accountId: "acc_test" },
  reasonCode: "polling",
  generation: 1,
  diagnosticCode: "reason-opened",
  observedAt: observation.occurredAt,
};
const read = {
  schemaVersion: "ChannelHealthRead/v1",
  connection: { ...fact.connection, status: "active" },
  health: {
    policyRevision: hash,
    evaluationGeneration: 1,
    state: "degraded",
    reasons: [reason],
    observedAt: observation.occurredAt,
  },
  policyAvailable: true,
  systemPaused: false,
  outboundPublicationAllowed: true,
  pollingAllowed: true,
  verifiedInboundSaleAllowed: true,
};

describe("channel-health-schema-closure", () => {
  it("accepts the complete versioned contracts and exact bounded policy", () => {
    expect(decodeChannelHealthObservation(observation)).toEqual(observation);
    expect(decodeChannelHealthChanged(fact)).toEqual(fact);
    expect(decodeChannelHealthRead(read)).toEqual(read);
    expect(decodeChannelHealthPolicy(channelHealthPolicy.defaultValue)).toEqual({
      windowSeconds: 900,
      consecutiveFailureThreshold: 3,
      failureBudgetCount: 5,
    });
    for (const value of [1, 2_592_000])
      expect(
        decodeChannelHealthPolicy({
          windowSeconds: value,
          consecutiveFailureThreshold: value,
          failureBudgetCount: value,
        }).windowSeconds,
      ).toBe(value);
  });
  it("rejects every extra or missing observation field and malformed authority", () => {
    for (const key of Object.keys(observation)) {
      const missing = Object.fromEntries(Object.entries(observation).filter(([name]) => name !== key));
      expect(() => decodeChannelHealthObservation(missing), key).toThrow("invalid-health-contract");
    }
    for (const patch of [
      { raw: "exception" },
      { sourceAttempt: 0 },
      { resultOrdinal: 1.5 },
      { evaluationGeneration: 0 },
      { sourceKind: "polling", reasonCode: "drift" },
      { occurredAt: "2026-09-12T12:00:00" },
      { fingerprint: "credential-secret" },
      { policyRevision: "old" },
    ])
      expect(() => decodeChannelHealthObservation({ ...observation, ...patch })).toThrow("invalid-health-contract");
  });
  it("closes every nested query, reason and fact object", () => {
    expect(() => decodeChannelHealthQuery({ ...fact.connection, seller: "raw" })).toThrow();
    expect(() => decodeChannelHealthChanged({ ...fact, connection: { ...fact.connection, raw: "body" } })).toThrow();
    expect(() => decodeChannelHealthRead({ ...read, connection: { ...read.connection, raw: "body" } })).toThrow();
    expect(() => decodeChannelHealthRead({ ...read, health: { ...read.health, raw: "body" } })).toThrow();
    expect(() =>
      decodeChannelHealthRead({ ...read, health: { ...read.health, reasons: [{ ...reason, raw: "body" }] } }),
    ).toThrow();
    expect(() => decodeReasonGeneration({ ...reason, opening: { ...reason.opening, resultOrdinal: 1 } })).toThrow();
    expect(() => decodeReasonGeneration({ ...reason, generation: 0 })).toThrow();
    expect(() => decodeChannelHealthRead({ ...read, health: { ...read.health, reasons: [reason, reason] } })).toThrow();
  });
  it("validates all policy values, not key presence", () => {
    for (const key of Object.keys(channelHealthPolicy.defaultValue))
      for (const value of [0, -1, 2_592_001, 1.1, "3", null, {}, NaN, Infinity])
        expect(() => decodeChannelHealthPolicy({ ...channelHealthPolicy.defaultValue, [key]: value })).toThrow();
    expect(() => decodeChannelHealthPolicy({ ...channelHealthPolicy.defaultValue, providerLimit: 5 })).toThrow();
  });
  it("excludes attempts and ordinals from the canonical source work derivation", () => {
    const input = {
      sourceKind: "polling" as const,
      connectionId: "connection_test",
      authorityIdentity: hash,
      operationMode: "scheduled",
      setupGeneration: 1,
      scheduleGeneration: 1,
      policyRevision: hash,
    };
    expect(deriveChannelHealthSourceWorkId(input)).toBe(deriveChannelHealthSourceWorkId({ ...input }));
    expect(() => deriveChannelHealthSourceWorkId({ ...input, sourceAttempt: 2 } as typeof input)).toThrow();
    expect(() => deriveChannelHealthSourceWorkId({ ...input, resultOrdinal: 2 } as typeof input)).toThrow();
    expect(deriveChannelHealthSourceWorkId({ ...input, scheduleGeneration: 2 })).not.toBe(
      deriveChannelHealthSourceWorkId(input),
    );
  });
});

describe("channel-health-artifact-secret-scan", () => {
  it("uses an allowlisted diagnostic vocabulary and never reflects rejected secret bytes", () => {
    const markers = [
      "credential=synthetic-secret",
      "seller@example.invalid",
      "Authorization: Bearer synthetic-token",
      "raw exception/body",
      "x".repeat(129),
    ];
    for (const marker of markers) {
      for (const payload of [
        { ...fact, diagnosticCode: marker },
        { ...fact, rawException: marker },
        { ...fact, connection: { ...fact.connection, sellerIdentity: marker } },
      ]) {
        try {
          decodeChannelHealthChanged(payload);
          throw new Error("accepted secret");
        } catch (error) {
          expect(String(error)).toContain("invalid-health-contract");
          expect(String(error)).not.toContain(marker);
        }
      }
    }
    const artifacts = JSON.stringify([
      decodeChannelHealthChanged(fact),
      decodeChannelHealthRead(read),
      decodeChannelHealthObservation(observation),
    ]);
    for (const marker of markers) expect(artifacts).not.toContain(marker);
  });
});
