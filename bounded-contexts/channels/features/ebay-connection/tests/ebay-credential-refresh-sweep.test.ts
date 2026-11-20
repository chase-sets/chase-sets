import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ChannelHealthRead, ConnectionHealthServices } from "../../connection-health/domain/contracts";
import type { ChannelCredentialEnvelope } from "../../credentials/domain/contracts";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { createEbayCredentialRefresh } from "../api/credential-refresh";
import { parseTokenResponse } from "../domain/oauth";
import type { RefreshClaim } from "../read-model/refresh-schedule";

function fixture() {
  const at = new Date("2026-11-16T00:00:00.000Z");
  const context: RefreshClaim["context"] = {
    tenantId: "tnt_synthetic",
    audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
  };
  const seed = "connection_a_paused_seed";
  const later = "connection_b_later_seed";
  const due: RefreshClaim = {
    connection_id: "connection_c_healthy_due",
    account_id: context.audit.forAccountId,
    token_generation: "1",
    schedule_generation: "3",
    attempt: 1,
    lease_id: "synthetic-lease",
    context,
  };
  const calls: string[] = [];
  const query = vi.fn<PgQueryable["query"]>(async <Row>(sql: string, values: readonly unknown[] = []) => {
    calls.push(sql === "ROLLBACK" || sql === "COMMIT" ? sql : `${sql.split("\n")[0]}:${values[0] ?? ""}`);
    let rows: unknown[] = [];
    if (sql.includes("FROM channels_connection_credentials c"))
      rows = [seed, later].map((connection_id) => ({
        connection_id,
        account_id: context.audit.forAccountId,
        token_generation: "1",
        tenant_id: context.tenantId,
        for_account_id: context.audit.forAccountId,
      }));
    if (sql.startsWith("SELECT 1 FROM channels_ebay_credential_refresh") && values[0] === due.connection_id)
      rows = [{}];
    if (sql.includes("WITH candidate AS") && !claimed) {
      claimed = true;
      rows = [due];
    }
    return { rows: rows as Row[] };
  });
  let claimed = false;
  const db: PgTransactionalPool = { query, connect: async () => ({ query, release() {} }) };
  const read: ChannelHealthRead = {
    schemaVersion: "ChannelHealthRead/v1",
    connection: { connectionId: seed, accountId: context.audit.forAccountId, status: "paused" },
    health: {
      policyRevision: "a".repeat(64),
      evaluationGeneration: 1,
      state: "unknown",
      reasons: [],
      observedAt: null,
    },
    policyAvailable: true,
    systemPaused: false,
    outboundPublicationAllowed: false,
    pollingAllowed: false,
    verifiedInboundSaleAllowed: true,
  };
  const submit = vi.fn<ConnectionHealthServices["submitObservation"]>(async (observation) => ({
    outcome: observation.connectionId === seed ? "inert" : "accepted",
    health: read,
  }));
  const tokens = parseTokenResponse(
    {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 7200,
      refresh_token_expires_in: 1000000,
      token_type: "User Access Token",
    },
    at.toISOString(),
  );
  const envelope = (connectionId: string) =>
    ({ connectionId, accountId: context.audit.forAccountId, tokenGeneration: 1 }) as ChannelCredentialEnvelope;
  const credentials = createChannelCredentialRuntime();
  vi.spyOn(credentials, "replace").mockResolvedValue(envelope(due.connection_id));
  const refresh = vi.fn(async () => tokens);
  const maintenance = createEbayCredentialRefresh({
    db,
    now: () => at,
    credentials,
    health: {
      readConnectionHealth: async (target) => ({
        ...read,
        connection: { ...read.connection, ...target, status: target.connectionId === seed ? "paused" : "active" },
      }),
      submitObservation: submit,
      listOpenReasonGenerations: async () => [],
      sweepConnectorLiveness: async () => ({ examined: 0, accepted: 0, refusals: [] }),
    },
    current: async (target, _generation, work, tx) =>
      work(
        tx ?? db,
        envelope(target.connectionId),
        target.connectionId === seed
          ? { ...tokens, accessExpiresAt: new Date(at.getTime() + 2250000).toISOString() }
          : tokens,
      ),
    currentEnvelope: async (target, _generation, work, tx) => work(tx ?? db, envelope(target.connectionId)),
    provider: { refresh, exchange: async () => tokens, identity: async () => "synthetic", revoke: async () => 200 },
  });
  return { maintenance, calls, submit, refresh, seed, later, due };
}

describe("ebay-credential-refresh sweep seed admission", () => {
  it("rolls back a refused paused pre-slice seed, continues later seeds and drains unrelated healthy due work", async () => {
    const f = fixture();
    expect(await f.maintenance.sweep()).toBe(1);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls.map(([observation]) => [observation.connectionId, observation.outcome])).toEqual([
      [f.seed, "failure"],
      [f.due.connection_id, "success"],
    ]);
    const rollback = f.calls.indexOf("ROLLBACK");
    const laterSeed = f.calls.findIndex((call) => call.startsWith("SELECT 1 FROM") && call.endsWith(`:${f.later}`));
    const drain = f.calls.findIndex((call) => call.includes("WITH candidate AS"));
    expect(rollback).toBeGreaterThan(-1);
    expect(laterSeed).toBeGreaterThan(rollback);
    expect(drain).toBeGreaterThan(laterSeed);
    expect(f.calls.slice(0, rollback)).not.toContain("COMMIT");
    expect(await f.maintenance.sweep()).toBe(0);
    expect(f.calls.filter((call) => call === "ROLLBACK")).toHaveLength(2);
    expect(f.submit.mock.calls.filter(([observation]) => observation.connectionId === f.seed)).toHaveLength(2);
  });

  it("rolls back and propagates unexpected seed errors instead of treating them as deferred admission", async () => {
    const f = fixture();
    const error = new Error("synthetic-unexpected-health-error");
    f.submit.mockRejectedValueOnce(error);
    await expect(f.maintenance.sweep()).rejects.toBe(error);
    expect(f.calls).toContain("ROLLBACK");
    expect(f.calls.some((call) => call.includes("WITH candidate AS"))).toBe(false);
    expect(f.refresh).not.toHaveBeenCalled();
  });
});
