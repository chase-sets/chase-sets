import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type {
  ChannelHealthRead,
  ChannelHealthSubmission,
  ConnectionHealthServices,
} from "../../connection-health/domain/contracts";
import type { ChannelCredentialEnvelope } from "../../credentials/domain/contracts";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { createEbayCredentialRefresh } from "../api/credential-refresh";
import { parseTokenResponse } from "../domain/oauth";
import type { RefreshClaim } from "../read-model/refresh-schedule";

const at = new Date("2026-11-16T00:00:00.000Z");
const claim: RefreshClaim = {
  connection_id: "connection_synthetic",
  account_id: "acc_synthetic",
  token_generation: "1",
  schedule_generation: "3",
  attempt: 6,
  lease_id: "synthetic-lease",
  context: { tenantId: "tnt_synthetic", audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" } },
};
function fixture() {
  const calls: string[] = [];
  const query: PgQueryable["query"] = async <Row>(sql: string) => {
    calls.push(sql);
    return { rows: (sql.startsWith("SELECT 1 FROM channels_ebay_credential_refresh") ? [{}] : []) as Row[] };
  };
  const db: PgTransactionalPool = { query, connect: async () => ({ query, release() {} }) };
  let read: ChannelHealthRead = {
    schemaVersion: "ChannelHealthRead/v1",
    connection: { connectionId: claim.connection_id, accountId: claim.account_id, status: "active" },
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
    readConnectionHealth: vi.fn(async () => read),
    submitObservation: submit,
    listOpenReasonGenerations: async () => [],
    sweepConnectorLiveness: async () => ({ examined: 0, accepted: 0, refusals: [] }),
  };
  const envelope = {
    connectionId: claim.connection_id,
    accountId: claim.account_id,
    tokenGeneration: 1,
  } as ChannelCredentialEnvelope;
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
  const credentials = createChannelCredentialRuntime();
  const replace = vi.spyOn(credentials, "replace").mockResolvedValue(envelope);
  const refresh = vi.fn(async () => tokens);
  const maintenance = createEbayCredentialRefresh({
    db,
    now: () => at,
    health,
    credentials,
    current: async (_target, _generation, work, transaction) => work(transaction ?? db, envelope, tokens),
    currentEnvelope: async (_target, _generation, work, transaction) => work(transaction ?? db, envelope),
    provider: { refresh, exchange: async () => tokens, identity: async () => "synthetic", revoke: async () => 200 },
  });
  return {
    maintenance,
    calls,
    submit,
    refresh,
    replace,
    tokens,
    get read() {
      return read;
    },
    setStatus(status: ChannelHealthRead["connection"]["status"]) {
      read = { ...read, connection: { ...read.connection, status } };
    },
  };
}

describe("ebay-credential-refresh completion admission", () => {
  it("defers paused attempt-6 work before sending without consuming its retry budget", async () => {
    const f = fixture();
    f.setStatus("paused");
    expect(await f.maintenance.process(claim)).toBe(false);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.calls.some((sql) => sql.startsWith("UPDATE") || sql.startsWith("INSERT"))).toBe(false);
  });

  it.each<ChannelHealthSubmission["outcome"]>(["inert", "stale", "policy-unavailable", "conflicting-terminal"])(
    "rolls back completion on %s intake instead of finalizing custody or schedule",
    async (outcome) => {
      const f = fixture();
      f.submit.mockResolvedValue({ outcome, health: f.read });
      expect(await f.maintenance.process(claim)).toBe(false);
      expect(f.replace).toHaveBeenCalledOnce();
      expect(f.submit).toHaveBeenCalledWith(expect.anything(), claim.context, expect.anything());
      expect(f.calls).toContain("ROLLBACK");
      expect(f.calls).not.toContain("COMMIT");
      expect(
        f.calls.some((sql) => sql.includes("attempt=0") || sql.startsWith("UPDATE channels_ebay_credential_refresh")),
      ).toBe(false);
    },
  );

  it.each(["refusal", "short-lifetime rejection", "same-material success"])(
    "pause arriving mid-refresh refuses %s completion and retains attempt/cycle for resume",
    async (mode) => {
      const f = fixture();
      f.refresh.mockImplementation(async () => {
        f.setStatus("paused");
        f.submit.mockResolvedValue({ outcome: "inert", health: f.read });
        if (mode === "refusal") throw new Error("synthetic-refusal");
        return mode === "short-lifetime rejection"
          ? { ...f.tokens, accessExpiresAt: new Date(at.getTime() + 2250000).toISOString() }
          : f.tokens;
      });
      expect(await f.maintenance.process(claim)).toBe(false);
      expect(f.submit.mock.calls[0][0]).toMatchObject({
        sourceAttempt: 6,
        outcome: mode === "same-material success" ? "success" : "failure",
      });
      expect(f.calls).toContain("ROLLBACK");
      expect(f.calls).not.toContain("COMMIT");
      expect(
        f.calls.some((sql) => sql.includes("attempt=0") || sql.startsWith("UPDATE channels_ebay_credential_refresh")),
      ).toBe(false);
      f.setStatus("active");
      f.submit.mockResolvedValue({ outcome: "accepted", health: f.read });
      f.refresh.mockRejectedValue(new Error("synthetic-refusal"));
      expect(await f.maintenance.process(claim)).toBe(true);
      expect(f.submit.mock.calls[1][0]).toMatchObject({
        sourceAttempt: 6,
        sourceWorkId: f.submit.mock.calls[0][0].sourceWorkId,
        outcome: "failure",
      });
      expect(f.calls).toContain("COMMIT");
    },
  );

  it.each<ChannelHealthSubmission["outcome"]>(["accepted", "replayed"])(
    "commits same-material success only with %s health intake in the completion transaction",
    async (outcome) => {
      const f = fixture();
      f.submit.mockResolvedValue({ outcome, health: f.read });
      expect(await f.maintenance.process(claim)).toBe(true);
      expect(f.calls).toContain("COMMIT");
      expect(f.calls).not.toContain("ROLLBACK");
      expect(f.calls.some((sql) => sql.includes("attempt=0"))).toBe(true);
    },
  );
});
