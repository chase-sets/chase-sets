import { afterEach, expect, it, vi } from "vitest";
import { describeDb, target, transportContext, transportDatabase } from "./transport-test-support";
import { connectorPolicyDefaults } from "../domain/policy";
import { channelHealthReasons } from "../../connection-health/domain/contracts";
import { healthDigest } from "../../connection-health/domain/identity";
import { module as channelsModule } from "../../../index";

describeDb("connector-feed-steady-state / connector-feed-connection-state-matrix", () => {
  const h = transportDatabase("connector_steady_7994");
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each([false, true])("restarts into the exact stable drained E1/E2/E3 matrix, paused=%s", async (paused) => {
    if (paused) await h.pause();
    h.restart();
    const reserve = vi.spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations");
    const hold = vi.spyOn(h.services.connectionHealth, "readConnectionHealth");
    const before = await h.effects();
    const response = await h.request("claim");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reservation: null, pollWindowSeconds: 60 });
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toHaveLength(1);
    expect(after.e2).not.toEqual(before.e2);
    expect(after.e2[0]).toMatchObject({ pairing_id: h.pairingId, served_poll_window_seconds: 60 });
    expect(after.e3).toHaveLength(before.e3.length + 1);
    expect(reserve).toHaveBeenCalledTimes(paused ? 0 : 1);
    expect(hold).toHaveBeenCalledTimes(paused ? 0 : 1);
  });
  it("does not regress E2 on an older poll clock or emit an E2 event", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = Date.now();
    vi.setSystemTime(at + 1000);
    expect((await h.request("claim")).status).toBe(200);
    await h.connectorPolicy({ ...connectorPolicyDefaults, pollWindowSeconds: 75 });
    const before = await h.effects();
    vi.setSystemTime(at);
    const older = await h.request("claim");
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ reservation: null, pollWindowSeconds: 75 });
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toEqual(before.e2);
    expect(after.e3).toHaveLength(before.e3.length + 1);
  });
  it("releases authority before reserve and keeps admitted E2 when reservation fails", async () => {
    let acquiredReleasedAuthorityLock = false;
    const reserve = vi
      .spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations")
      .mockImplementation(async () => {
        const independent = await h.db.connect();
        try {
          await independent.query("BEGIN");
          await independent.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1 FOR UPDATE NOWAIT", [
            `channels.connection-${target.connectionId}`,
          ]);
          acquiredReleasedAuthorityLock = true;
        } finally {
          await independent.query("ROLLBACK");
          independent.release();
        }
        throw new Error("reservation-secret-sentinel");
      });
    const before = await h.effects();
    const response = await h.request("claim");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"code":"unavailable"}');
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).not.toEqual(before.e2);
    expect(after.e3).toHaveLength(before.e3.length + 1);
    expect(JSON.stringify(after)).not.toContain("reservation-secret-sentinel");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(acquiredReleasedAuthorityLock).toBe(true);
  });
  it.each(["membership-lost", "revoked"] as const)(
    "rechecks %s after a request waits on the canonical authority lock",
    async (change) => {
      const reserve = vi.spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations");
      const hold = vi.spyOn(h.services.connectionHealth, "readConnectionHealth");
      const before = await h.effects();
      const writer = await h.db.connect();
      let pending: Promise<Response> | undefined;
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1 FOR UPDATE", [
          `channels.connection-${target.connectionId}`,
        ]);
        pending = h.request("claim");
        await expect
          .poll(
            async () =>
              (
                await h.db.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%event_store_streams%' AND pid<>pg_backend_pid()`)
              ).rows.length,
          )
          .toBeGreaterThan(0);
        if (change === "membership-lost") await h.membership(false);
        else await h.revokeAuthGrant();
        await writer.query("COMMIT");
        expect((await pending).status).toBe(403);
        const after = await h.effects();
        expect(after.e1).toEqual(before.e1);
        expect(after.e2).toEqual(before.e2);
        expect(after.e3).toHaveLength(before.e3.length + 1);
        expect(reserve).not.toHaveBeenCalled();
        expect(hold).not.toHaveBeenCalled();
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
        if (pending) await pending;
      }
    },
  );
  it.each(["membership-lost", "invalid", "revoked", "unpaired", "disconnected"] as const)(
    "refuses %s before E2 and the canonical hold",
    async (state) => {
      if (state === "membership-lost") await h.membership(false);
      if (state === "revoked") await h.services.connectorFeed.revoke(h.token);
      if (state === "unpaired") {
        const detail = await h.services.connectorFeed.detail(target);
        if (!detail.pairingId || detail.revision === null) throw new Error("missing-fixture-pairing");
        await h.services.connectorFeed.unpair(target, detail.pairingId, detail.revision, {
          userId: transportContext.audit.performedByUserId,
          accountId: target.accountId,
          permissions: ["channels.manage"],
        });
      }
      if (state === "disconnected") {
        await h.services.connections.disconnectChannelConnection(target, transportContext);
        await h.projectConnection();
      }
      h.restart();
      const reserve = vi.spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations");
      const hold = vi.spyOn(h.services.connectionHealth, "readConnectionHealth");
      const before = await h.effects();
      const response = await h.request("claim", {}, state === "invalid" ? { token: "invalid-sentinel" } : {});
      expect(response.status).toBe(403);
      const after = await h.effects();
      expect(after.e1).toEqual(before.e1);
      expect(after.e2).toEqual(before.e2);
      expect(after.e3).toHaveLength(before.e3.length + 1);
      expect(reserve).not.toHaveBeenCalled();
      expect(hold).not.toHaveBeenCalled();
    },
  );
  it("attributes a pending policy only to the unchanged production hold, equal to the direct health twin once", async () => {
    const twinId = "connection_health_twin";
    await h.connection(twinId);
    await h.healthy(twinId);
    await h.observation(target.connectionId, "polling", "failure", 2);
    await h.observation(twinId, "polling", "failure", 2);
    await h.policy({ windowSeconds: 900, consecutiveFailureThreshold: 1, failureBudgetCount: 5 });
    const mark = await h.db.query<{ position: string }>(
      "SELECT COALESCE(MAX(global_position),0)::text AS position FROM event_store_events",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    h.restart();
    const hold = vi.spyOn(h.services.connectionHealth, "readConnectionHealth");
    const before = await h.effects();
    const response = await h.request("claim");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reservation: null, pollWindowSeconds: 60 });
    expect(hold).toHaveBeenCalledTimes(1);
    const twin = await h.services.connectionHealth.readConnectionHealth({ ...target, connectionId: twinId });
    expect(twin.health.state).toBe("failing");
    const eventRows = await h.db.query<{ stream_id: string; event_type: string; payload: unknown }>(
      "SELECT stream_id,event_type,payload FROM event_store_events WHERE global_position > $1 ORDER BY global_position",
      [mark.rows[0]?.position],
    );
    const normalize = (value: unknown, id: string) => {
      let json = JSON.stringify(value).replaceAll(id, "connection_twin");
      for (const reason of channelHealthReasons)
        for (const outcome of ["success", "failure"])
          for (const attempt of [1, 2]) {
            json = json.replaceAll(
              healthDigest(["transport-fixture", id, reason, outcome, attempt]),
              `source_${reason}_${outcome}_${attempt}`,
            );
          }
      return JSON.parse(json);
    };
    const normalized = (id: string) =>
      eventRows.rows
        .filter((row) => row.stream_id.endsWith(id))
        .map((row) => normalize({ type: row.event_type, payload: row.payload }, id));
    expect(normalized(target.connectionId).length).toBeGreaterThan(0);
    expect(normalized(target.connectionId)).toEqual(normalized(twinId));
    expect(eventRows.rows).toHaveLength(normalized(target.connectionId).length * 2);
    const healthRows = await h.db.query<{
      connection_id: string;
      state: string;
      reasons: unknown;
      policy_revision: string;
      evaluation_generation: string;
    }>(
      "SELECT connection_id,state,reasons,policy_revision,evaluation_generation::text FROM channel_connection_health ORDER BY connection_id",
    );
    const primary = healthRows.rows.find((row) => row.connection_id === target.connectionId);
    const other = healthRows.rows.find((row) => row.connection_id === twinId);
    expect(normalize(primary, target.connectionId)).toEqual(normalize(other, twinId));
    const attention = await h.db.query<{ connection_id: string }>(
      "SELECT * FROM channel_connection_attention ORDER BY connection_id,reason_code,reason_generation",
    );
    expect(
      normalize(
        attention.rows.filter((row) => row.connection_id === target.connectionId),
        target.connectionId,
      ),
    ).toEqual(
      normalize(
        attention.rows.filter((row) => row.connection_id === twinId),
        twinId,
      ),
    );
    const after = await h.effects();
    const { event_store_events: _eventsBefore, ...transportBefore } = before.e1;
    const { event_store_events: _eventsAfter, ...transportAfter } = after.e1;
    expect(transportAfter).toEqual(transportBefore);
    expect(after.e3).toHaveLength(before.e3.length + 1);
    expect((await h.request("claim")).status).toBe(200);
    expect((await h.effects()).e1).toEqual(after.e1);
  });
  it("never activates a pending health policy on a paused or membership-refused poll", async () => {
    await h.observation(target.connectionId, "polling", "failure", 2);
    await h.policy({ windowSeconds: 900, consecutiveFailureThreshold: 1, failureBudgetCount: 5 });
    await h.pause();
    const hold = vi.spyOn(h.services.connectionHealth, "readConnectionHealth");
    const reserve = vi.spyOn(h.services.outboundSync, "reserveConnectorClaimedOperations");
    const before = await h.effects();
    expect((await h.request("claim")).status).toBe(200);
    expect((await h.effects()).e1).toEqual(before.e1);
    await h.membership(false);
    const paused = await h.effects();
    expect((await h.request("claim")).status).toBe(403);
    expect((await h.effects()).e1).toEqual(paused.e1);
    expect((await h.effects()).e2).toEqual(paused.e2);
    expect(hold).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
  it("fails closed with a withheld Auth port without E1, E2 or reserve activity", async () => {
    const withheld = channelsModule.createServices(h.db, {
      channelSaleRecorder: async (): Promise<never> => {
        throw new Error("must-not-record-sale");
      },
    });
    const reserve = vi.spyOn(withheld.outboundSync, "reserveConnectorClaimedOperations");
    const hold = vi.spyOn(withheld.connectionHealth, "readConnectionHealth");
    const before = await h.effects();
    for (const operation of ["claim", "report", "ingest"] as const) {
      const body =
        operation === "claim"
          ? {}
          : operation === "report"
            ? { reservationId: "cor_absent", outcomes: [] }
            : { inboundKind: "order", externalReference: "withheld", payload: { version: 1, records: [{}] } };
      expect((await h.request(operation, body, { service: withheld.connectorFeed })).status).toBe(503);
    }
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toEqual(before.e2);
    expect(after.e3).toHaveLength(before.e3.length + 3);
    expect(reserve).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });
  it("serves a valid active policy and refuses malformed active values rather than falling back", async () => {
    const documentId = await h.connectorPolicy({
      ...connectorPolicyDefaults,
      pollWindowSeconds: 75,
      maxOperationsPerClaim: 1,
    });
    const accepted = await h.request("claim");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ reservation: null, pollWindowSeconds: 75 });
    await h.db.query("UPDATE platform_policy_documents SET value=$1::jsonb WHERE document_id=$2", [
      JSON.stringify({ ...connectorPolicyDefaults, pollWindowSeconds: 0 }),
      documentId,
    ]);
    h.restart();
    const hold = vi.spyOn(h.services.connectionHealth, "readConnectionHealth");
    const before = await h.effects();
    const refused = await h.request("claim");
    expect(refused.status).toBe(503);
    expect((await h.effects()).e1).toEqual(before.e1);
    expect((await h.effects()).e2).toEqual(before.e2);
    expect((await h.effects()).e3).toHaveLength(before.e3.length + 1);
    expect(hold).not.toHaveBeenCalled();
  });
});
