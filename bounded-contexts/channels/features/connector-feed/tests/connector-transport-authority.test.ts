import { describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import { createUnavailableOutboundSyncServices } from "../../outbound-sync/tests/test-support";
import { createConnectorFeedRuntime, type ConnectorFeedServices } from "../api/runtime";
import { createConnectorTransport } from "../api/transport";
import { ConnectorPairingError, type ConnectorAuthority } from "../domain/contracts";
import { connectorPolicyDefaults, connectorTransportPolicy } from "../domain/policy";

function harness(paused = false, member = true) {
  const calls: string[] = [];
  const db: PgTransactionalPool = {
    query: vi.fn<PgTransactionalPool["query"]>().mockImplementation(async (sql) => {
      calls.push(sql.startsWith("UPDATE") ? "E2" : "pairing-fence");
      return { rows: [{ revision: 2, pairing_id: "pair_test" }] };
    }),
    connect: async (): Promise<never> => {
      throw new Error("unexpected-db-transaction");
    },
  };
  const authority: ConnectorAuthority = {
    connectionId: "connection_test",
    accountId: "acc_test",
    connectionState: paused ? "paused" : "active",
    inbound: "live",
    pairingId: "pair_test",
    claimReportAllowed: member,
    grant: {
      grantId: "grant_test",
      connectionId: "connection_test",
      accountId: "acc_test",
      pairingId: "pair_test",
      userId: "usr_test",
      clientId: "client_test",
      revision: 1,
      expiresAt: "2026-10-07T13:00:00Z",
      valid: true,
    },
  };
  const withAuthority: ConnectorFeedServices["withAuthority"] = async (input, work, identify) => {
    calls.push("authority");
    if (input.operation !== "ingest" && !member) throw new ConnectorPairingError("authorization-refused");
    identify?.({ connectionId: authority.connectionId, pairingId: authority.pairingId });
    const result = await work(authority, db);
    calls.push("commit");
    return result;
  };
  const reserve = vi.fn(async () => {
    calls.push("reserve");
    return null;
  });
  const report = vi.fn(async () => {
    calls.push("report");
  });
  const pairing = createConnectorFeedRuntime({ db, eventStore: createPostgresEventStore({ pool: db }) });
  const services = createConnectorTransport({
    db,
    authority: { ...pairing, withAuthority },
    outboundSync: {
      ...createUnavailableOutboundSyncServices(),
      reserveConnectorClaimedOperations: reserve,
      reportClaimedOperationOutcomes: report,
    },
    registry: createChannelProviderRegistry([]),
    resolvePolicy: async () => ({
      policyKey: connectorTransportPolicy.policyKey,
      value: connectorPolicyDefaults,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: "2026-10-07T12:00:00Z",
    }),
    now: () => new Date("2026-10-07T12:00:00Z"),
  });
  return {
    services,
    reserve,
    report,
    calls,
    input: { token: "synthetic", connectionId: "connection_test" },
    identify: vi.fn(),
  };
}

describe("connector authority and producer boundary", () => {
  it("commits fenced E2 before the sole producer reservation call", async () => {
    const h = harness();
    expect(await h.services.claim(h.input, {}, h.identify)).toEqual({ reservation: null, pollWindowSeconds: 60 });
    expect(h.calls).toEqual(["authority", "E2", "commit", "reserve"]);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: h.input.connectionId,
        claimant: { claimantKind: "connector", claimantId: "pair_test" },
        maxOperations: 100,
        leaseMs: 1_800_000,
        capabilities: [],
      }),
    );
  });
  it("passes only a declared order-pull capability to the producer and refuses unknown capabilities before authority", async () => {
    const h = harness();
    await h.services.claim(h.input, { capabilities: ["tcgplayer-order-pull"] }, h.identify);
    expect(h.reserve).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ["tcgplayer-order-pull"] }));
    for (const body of [
      { capabilities: ["listing-publish"] },
      { capabilities: ["tcgplayer-order-pull", "tcgplayer-order-pull"] },
      { capabilities: "tcgplayer-order-pull" },
      { operationKinds: ["tcgplayer-order-pull"] },
    ]) {
      const refused = harness();
      await expect(refused.services.claim(refused.input, body, refused.identify)).rejects.toMatchObject({
        code: "invalid-input",
      });
      expect(refused.calls).toEqual([]);
    }
  });
  it("does not even call reserve on paused polls, including a producer that would throw", async () => {
    const h = harness(true);
    h.reserve.mockRejectedValue(new Error("must-not-call-reserve"));
    expect(await h.services.claim(h.input, {}, h.identify)).toEqual({ reservation: null, pollWindowSeconds: 60 });
    expect(h.calls).toEqual(["authority", "E2", "commit"]);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("refuses membership before E2 and reserve", async () => {
    const h = harness(false, false);
    await expect(h.services.claim(h.input, {}, h.identify)).rejects.toMatchObject({ code: "authorization-refused" });
    expect(h.calls).toEqual(["authority"]);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("preserves the complete report vector and producer refusal without local settlement or E2", async () => {
    const h = harness();
    const value = {
      reservationId: "cor_test",
      outcomes: [
        {
          operationId: "cop_test",
          attemptId: "coa_test",
          claimGeneration: 5,
          desiredStateSequence: 9,
          outcome: { kind: "outcome-unknown" },
        },
      ],
    };
    await h.services.report(h.input, value, h.identify);
    expect(h.calls).toEqual(["authority", "report", "commit"]);
    expect(h.report).toHaveBeenCalledWith({
      ...value,
      claimant: { claimantKind: "connector", claimantId: "pair_test" },
    });
  });
});
