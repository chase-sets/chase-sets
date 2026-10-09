import { expect, it, vi } from "vitest";
import { describeDb, seller, target, transportContext, transportDatabase } from "./transport-test-support";
import { connectorLivenessSchemaSql, connectorLivenessSchemaMigrations } from "../read-model/liveness-schema";

describeDb("connector-liveness-authority-read", () => {
  const h = transportDatabase("connector_liveness_read_7932");
  const read = () => h.services.connectorFeed.readConnectorLivenessAuthority({ connectionId: target.connectionId });
  it.each(["heartbeat", "replace", "unpair", "revoke", "disconnect", "lazy-close", "authorize", "status"])(
    "transactional authority share lock blocks %s until commit",
    async (operation) => {
      let code: Awaited<ReturnType<typeof h.services.connectorFeed.createPairingCode>> | undefined;
      if (operation === "authorize") code = await h.services.connectorFeed.createPairingCode(target, seller);
      if (operation === "lazy-close") await h.revokeAuthGrant();
      const reader = await h.db.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const observed = await h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction(reader, {
          connectionId: target.connectionId,
        });
        expect(observed).toEqual(await read());
        const before = await read();
        if (operation === "heartbeat") pending = h.request("claim");
        if (operation === "replace") pending = h.services.connectorFeed.createPairingCode(target, seller);
        if (operation === "unpair") pending = h.services.connectorFeed.unpair(target, h.pairingId, 2, seller);
        if (operation === "revoke") pending = h.services.connectorFeed.revoke(h.token);
        if (operation === "disconnect")
          pending = h.services.connections.disconnectChannelConnection(target, transportContext);
        if (operation === "lazy-close") pending = h.services.connectorFeed.detail(target);
        if (operation === "status") pending = h.pause();
        if (operation === "authorize" && code) {
          vi.spyOn(h.services.connectorFeed, "createPairingCode").mockResolvedValue(code);
          pending = h.pair();
        }
        await expect
          .poll(
            async () =>
              (
                await h.db.query(
                  `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
           AND (query LIKE '%channel_connector_liveness_authority%' OR query LIKE '%channel_connections%')
           AND pid<>pg_backend_pid()`,
                )
              ).rows.length,
          )
          .toBeGreaterThan(0);
        expect(await read()).toEqual(before);
        await reader.query("COMMIT");
        await pending;
        if (operation === "status") expect((await read())?.connectionStatus).toBe("paused");
        else expect(await read()).not.toEqual(before);
      } finally {
        await reader.query("ROLLBACK");
        reader.release();
        if (pending) await pending;
      }
    },
  );
  it("reads the latest committed heartbeat when a writer wins first", async () => {
    const writer = await h.db.connect();
    const reader = await h.db.connect();
    let pending: ReturnType<typeof h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT connection_id FROM channel_connections WHERE connection_id=$1 FOR SHARE", [
        target.connectionId,
      ]);
      await writer.query(
        "SELECT connection_id FROM channel_connector_liveness_authority WHERE connection_id=$1 FOR UPDATE",
        [target.connectionId],
      );
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      pending = h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction(reader, {
        connectionId: target.connectionId,
      });
      await expect
        .poll(
          async () =>
            (
              await h.db.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF a%'",
              )
            ).rows.length,
        )
        .toBeGreaterThan(0);
      await writer.query(
        `UPDATE channel_connector_liveness_authority SET heartbeat_revision=heartbeat_revision+1,
        last_seen_at='2026-10-07T12:00:00Z',served_poll_window_seconds=60,served_policy_identity=$2,
        heartbeat_due_at='2026-10-07T12:01:00Z' WHERE connection_id=$1 AND live_pairing_id=$3 AND last_seen_at IS NULL`,
        [target.connectionId, "a".repeat(64), h.pairingId],
      );
      await writer.query("COMMIT");
      expect(await pending).toMatchObject({ heartbeatRevision: 1, servedPolicyIdentity: "a".repeat(64) });
    } finally {
      await writer.query("ROLLBACK");
      if (pending) await pending;
      await reader.query("ROLLBACK");
      writer.release();
      reader.release();
    }
  });
  it("null before first pairing supplies no authority lock; first pairing proceeds", async () => {
    const connectionId = "connection_never_paired";
    await h.connection(connectionId);
    const reader = await h.db.connect();
    try {
      await reader.query("BEGIN");
      expect(
        await h.services.connectorFeed.readConnectorLivenessAuthorityInTransaction(reader, { connectionId }),
      ).toBeNull();
      const next = await h.services.connectorFeed.createPairingCode({ ...target, connectionId }, seller);
      expect(await h.services.connectorFeed.readConnectorLivenessAuthority({ connectionId })).toMatchObject({
        authorityGeneration: 1,
        livePairingId: next.pairingId,
        heartbeatRevision: 0,
        lastSeenAt: null,
      });
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
  });
  it.each(["boot", "migration"])(
    "%s idempotently backfills pre-table pairings without inventing heartbeat",
    async (kind) => {
      await h.db.query("DROP TABLE channel_connector_liveness_authority");
      async function apply() {
        if (kind === "boot") await h.db.query(connectorLivenessSchemaSql);
        else for (const statement of connectorLivenessSchemaMigrations[0]!.statements) await h.db.query(statement);
      }
      await apply();
      expect(await read()).toMatchObject({
        authorityGeneration: 1,
        livePairingId: h.pairingId,
        heartbeatRevision: 0,
        lastSeenAt: null,
      });
      expect((await h.request("claim")).status).toBe(200);
      const heartbeat = await read();
      expect(heartbeat).toMatchObject({ heartbeatRevision: 1, servedPollWindowSeconds: 60 });
      await apply();
      expect(await read()).toEqual(heartbeat);
      await h.services.connections.disconnectChannelConnection(target, transportContext);
      await h.projectConnection();
      const removed = await read();
      await apply();
      expect(await read()).toEqual(removed);
    },
  );
});
