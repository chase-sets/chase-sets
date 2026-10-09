import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import { canonicalJson } from "../../outbound-sync/domain/validation";
import { connectorTransportPolicy, type ConnectorPolicy } from "../domain/policy";
import { deriveServedPolicyIdentity } from "../domain/served-policy-identity";
import { assertConnectorLivenessAuthority, assertConnectorLivenessCandidates } from "../domain/liveness";
import { connectorLivenessSchemaSql, connectorLivenessSchemaMigrations } from "../read-model/liveness-schema";

const snapshot: ResolvedPolicy<ConnectorPolicy> = {
  policyKey: connectorTransportPolicy.policyKey,
  source: "policy",
  documentId: "document_test",
  effectiveFrom: "2026-10-01T00:00:00Z",
  effectiveUntil: null,
  resolvedAt: "2026-10-07T12:00:00Z",
  value: connectorTransportPolicy.defaultValue,
};
describe("served-policy-identity", () => {
  it("hashes the complete encoded admission snapshot, excluding resolvedAt", () => {
    const { resolvedAt: _, ...identity } = snapshot;
    expect(deriveServedPolicyIdentity(snapshot)).toBe(
      createHash("sha256").update(canonicalJson(identity)).digest("hex"),
    );
    expect(deriveServedPolicyIdentity({ ...snapshot, resolvedAt: "2026-10-08T12:00:00Z" })).toBe(
      deriveServedPolicyIdentity(snapshot),
    );
    for (const key of Object.keys(snapshot.value) as (keyof ConnectorPolicy)[]) {
      expect(
        deriveServedPolicyIdentity({ ...snapshot, value: { ...snapshot.value, [key]: snapshot.value[key] - 1 } }),
      ).not.toBe(deriveServedPolicyIdentity(snapshot));
    }
  });
  it("distinguishes compiled fallbacks and metadata without document aliases", () => {
    const fallback = { ...snapshot, source: "fallback" as const, documentId: null, effectiveFrom: null };
    expect(deriveServedPolicyIdentity(fallback)).not.toBe(deriveServedPolicyIdentity(snapshot));
    expect(deriveServedPolicyIdentity({ ...fallback, value: { ...fallback.value, pollWindowSeconds: 75 } })).not.toBe(
      deriveServedPolicyIdentity(fallback),
    );
    expect(deriveServedPolicyIdentity({ ...snapshot, documentId: "different" })).not.toBe(
      deriveServedPolicyIdentity(snapshot),
    );
  });
  it.each([
    { ...snapshot, unknown: true },
    { ...snapshot, value: { ...snapshot.value, unknown: true } },
    { ...snapshot, effectiveFrom: "2026-10-01" },
    { ...snapshot, value: { ...snapshot.value, pollWindowSeconds: 3601 } },
    { ...snapshot, source: "fallback" },
  ])("refuses malformed snapshot %#", (value) =>
    expect(() => deriveServedPolicyIdentity(value as typeof snapshot)).toThrow(),
  );
});

describe("connector liveness closed contracts", () => {
  const row = {
    connectionId: "connection_test",
    connectionStatus: "active",
    authorityGeneration: 1,
    livePairingId: "pair_test",
    heartbeatRevision: 1,
    lastSeenAt: "2026-10-07T12:00:00Z",
    servedPollWindowSeconds: 60,
    servedPolicyIdentity: "a".repeat(64),
    heartbeatDueAt: "2026-10-07T12:01:00Z",
  };
  it("accepts complete and unserved records", () => {
    expect(() => assertConnectorLivenessAuthority(row)).not.toThrow();
    expect(() =>
      assertConnectorLivenessAuthority({
        ...row,
        heartbeatRevision: 0,
        lastSeenAt: null,
        servedPollWindowSeconds: null,
        servedPolicyIdentity: null,
        heartbeatDueAt: null,
      }),
    ).not.toThrow();
  });
  it.each([
    { ...row, lastSeenAt: null },
    { ...row, livePairingId: null },
    { ...row, lastSeenAt: "2026-10-07" },
    { ...row, servedPollWindowSeconds: 3601 },
    { ...row, authorityGeneration: 0 },
    { ...row, extra: true },
    { ...row, heartbeatDueAt: "2026-10-07T12:02:00Z" },
  ])("rejects partial or invalid record %#", (value) => {
    expect(() => assertConnectorLivenessAuthority(value)).toThrow();
  });
  it("closes candidate cursors and bounds pages", () => {
    expect(() => assertConnectorLivenessCandidates({ dueAt: row.heartbeatDueAt, limit: 100 })).not.toThrow();
    expect(() => assertConnectorLivenessCandidates({ dueAt: row.heartbeatDueAt, limit: 101 })).toThrow();
    expect(() =>
      assertConnectorLivenessCandidates({
        dueAt: row.heartbeatDueAt,
        limit: 1,
        after: { heartbeatDueAt: row.heartbeatDueAt, connectionId: row.connectionId, extra: true } as never,
      }),
    ).toThrow();
  });
  it("ships the exact boot DDL, backfill and partial index in one ledgered migration", () => {
    expect(connectorLivenessSchemaMigrations).toHaveLength(1);
    expect(connectorLivenessSchemaSql).toBe(connectorLivenessSchemaMigrations[0]!.statements.join(";\n") + ";");
    expect(connectorLivenessSchemaSql).toContain("WHERE live_pairing_id IS NOT NULL");
    expect(connectorLivenessSchemaSql).toContain("ON CONFLICT (connection_id) DO NOTHING");
  });
});
