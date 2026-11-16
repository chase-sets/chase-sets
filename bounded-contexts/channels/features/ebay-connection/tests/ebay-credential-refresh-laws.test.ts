import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelCredentialEnvelope } from "../../credentials/domain/contracts";
import type { ConnectionHealthServices, ChannelHealthRead } from "../../connection-health/domain/contracts";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { createEbayCredentialRefresh } from "../api/credential-refresh";
import { createRefreshSchedule, scheduleCredentialRefresh, type RefreshClaim } from "../read-model/refresh-schedule";
import { ebayMaintenanceRevision } from "../domain/credential-maintenance";
import { healthDigest } from "../../connection-health/domain/identity";
import { parseTokenResponse } from "../domain/oauth";

const at = new Date("2026-11-16T00:00:00.000Z");
const context: EventStoreContext = {
  tenantId: "tnt_refresh",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_refresh" },
};
const envelope: ChannelCredentialEnvelope = {
  version: "ChannelCredentialEnvelope/v1",
  rowId: "credential-refresh",
  kind: "oauth-token-set",
  providerKey: "ebay",
  environment: "sandbox",
  accountId: "acc_refresh",
  connectionId: "connection_refresh",
  payloadFormat: "ChannelOAuthTokenSet/v1",
  tokenGeneration: 1,
  envelopeRevision: 1,
  keyId: "synthetic",
  createdAt: at.toISOString(),
  updatedAt: at.toISOString(),
};
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
const claim: RefreshClaim = {
  connection_id: envelope.connectionId,
  account_id: envelope.accountId,
  token_generation: "1",
  schedule_generation: "1",
  attempt: 1,
  lease_id: "synthetic-lease",
  context,
};
function database() {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const query: PgQueryable["query"] = async <Row>(sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: (sql.startsWith("SELECT 1 FROM channels_ebay_credential_refresh") ? [{}] : []) as Row[] };
  };
  const db: PgTransactionalPool = { query, connect: async () => ({ query, release() {} }) };
  return { db, calls };
}
describe("ebay-credential-refresh laws and mutation oracles", () => {
  it("off-by-one retry index: attempts 1..5 select the exact backoff and attempt 6 has no due work", async () => {
    const f = database(),
      schedule = createRefreshSchedule(f.db, () => at);
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = await schedule.fail(f.db, { ...claim, attempt }, false);
      const call = f.calls.at(-1)!;
      expect(call.values.slice(0, 5)).toEqual([envelope.connectionId, "1", "1", attempt, "synthetic-lease"]);
      expect(call.values[6]).toEqual(
        attempt === 6 ? null : new Date(at.getTime() + [60, 300, 1800, 7200, 21600][attempt - 1] * 1000),
      );
      expect(result).toBe(attempt === 6 ? "exhausted" : "retryable");
    }
  });
  it("attempt-reset mutant: same-material succession resets attempt zero and advances the persisted cycle", async () => {
    const f = database();
    await scheduleCredentialRefresh(f.db, envelope, tokens, context, at, claim);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].sql).toContain("attempt=0");
    expect(f.calls[0].sql).toContain("$5,0,$6,NULL,NULL,$7");
    expect(f.calls[0].values).toEqual([
      envelope.connectionId,
      1,
      envelope.accountId,
      JSON.stringify(context),
      2,
      new Date("2026-11-16T01:30:00Z"),
      "succeeded",
    ]);
  });
  it("omitted-cycle identity mutant: otherwise identical attempts remain different work and use producer, not health, policy identity", async () => {
    const f = database();
    const read: ChannelHealthRead = {
      schemaVersion: "ChannelHealthRead/v1",
      connection: { connectionId: envelope.connectionId, accountId: envelope.accountId, status: "pending-setup" },
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
    const submit = vi.fn<ConnectionHealthServices["submitObservation"]>(async () => ({
      outcome: "accepted",
      health: read,
    }));
    const health: ConnectionHealthServices = {
      submitObservation: submit,
      readConnectionHealth: async () => read,
      listOpenReasonGenerations: async () => [],
      sweepConnectorLiveness: async () => ({ examined: 0, accepted: 0, refusals: [] }),
    };
    const credentials = createChannelCredentialRuntime();
    vi.spyOn(credentials, "replace").mockResolvedValue(envelope);
    const refresh = vi.fn(async () => tokens);
    const maintenance = createEbayCredentialRefresh({
      db: f.db,
      now: () => at,
      health,
      credentials,
      current: async (_target, _generation, work, transaction) => work(transaction ?? f.db, envelope, tokens),
      currentEnvelope: async (_target, _generation, work, transaction) => work(transaction ?? f.db, envelope),
      provider: {
        exchange: async () => tokens,
        refresh,
        identity: async () => "synthetic",
        revoke: async () => 200,
      },
    });
    await maintenance.process(claim);
    await maintenance.process({ ...claim, schedule_generation: "2" });
    expect(submit).toHaveBeenCalledTimes(2);
    const observations = submit.mock.calls.map(([observation]) => observation);
    expect(observations.map((o) => o.fingerprint)).toEqual(
      [1, 2].map(() => healthDigest(["ebay-credential", envelope.connectionId])),
    );
    expect(observations.map((o) => o.sourceWorkId)).toEqual(
      [1, 2].map((cycle) =>
        healthDigest(["ebay-credential-refresh", envelope.connectionId, 1, ebayMaintenanceRevision, cycle]),
      ),
    );
    expect(observations[0].sourceWorkId).not.toBe(observations[1].sourceWorkId);
    expect(observations.map((o) => o.policyRevision)).toEqual([read.health.policyRevision, read.health.policyRevision]);
    // An unmapped refusal is not terminal authority, including an exception that contains secret-like text.
    refresh.mockRejectedValueOnce(new Error("synthetic-private-provider-body"));
    await maintenance.process({ ...claim, schedule_generation: "3" });
    const failure = f.calls
      .filter((call) => call.sql.startsWith("UPDATE channels_ebay_credential_refresh SET last_outcome"))
      .at(-1)!;
    expect(failure.values[5]).toBe("retryable");
    expect(failure.values[6]).toEqual(new Date(at.getTime() + 60000));
    expect(JSON.stringify(submit.mock.calls)).not.toContain("synthetic-private-provider-body");
  });
});
