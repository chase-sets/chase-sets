import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { resolveActorFromSessionId } from "@chase-sets/auth/server";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import * as feedRuntime from "../../connector-feed/api/runtime";
import {
  describeDb,
  seller,
  target,
  transportContext,
  transportDatabase,
} from "../../connector-feed/tests/transport-test-support";
import type { ConnectorInbound } from "../../connector-feed/domain/transport";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";

describeDb("manual-sync-connector-coverage / manual-sync-coverage-composition", () => {
  const h = transportDatabase("manual_sync_coverage_7995");
  const live = { state: "live", reason: null };
  const dark = { state: "dark", reason: "inbound-authority-revoked" };
  async function coverage() {
    return (await h.services.manualSync.readPanel(target))?.inboundCoverage;
  }
  async function assertLive() {
    expect(await coverage()).toEqual(live);
  }

  it("all real panel builders share authority while connector-claimed runs retain no manual actions", async () => {
    await h.enqueue("1001");
    await h.db.query(
      `INSERT INTO channels_external_product_reference_facts VALUES ('tcgplayer','sku:2001','catalog_1001','[]','','linked',now(),1)`,
    );
    const at = new Date().toISOString();
    const staged = await h.services.tcgplayerCsv.ingestTcgplayerExportSnapshot({
      snapshotId: "snapshot_coverage_7995",
      connectionId: target.connectionId,
      surface: "staged",
      csv: "TCGplayer Id,Total Quantity,Add to Quantity,TCG Marketplace Price\n1001,0,0,1.00",
      limits: { maxRecords: 1 },
      ingestedAt: at,
      capturedAt: at,
      capturedAtSource: "operator-declared",
    });
    expect(staged.kind).toBe("parsed");
    const composed = await h.services.manualSync.compose(target, transportContext);
    expect(composed.inboundCoverage).toEqual(live);
    expect(composed.actions).toEqual(["download"]);
    const run = composed.run!;
    const input = { ...target, runId: run.runId, expectedRevision: run.revision };
    expect((await h.services.manualSync.retryClamp(input, transportContext)).inboundCoverage).toEqual(live);
    await h.revokeAuthGrant();
    expect((await h.services.manualSync.retryClamp(input, transportContext)).inboundCoverage).toEqual(dark);
    await h.pair();
    await assertLive();
    const claimed = await h.services.manualSync.claimAndDownload(input, transportContext);
    await h.services.manualSync.release({ ...input, expectedRevision: claimed.run.revision }, transportContext);
    const connector = await h.services.tcgplayerCsv.composeTcgplayerSyncRun(
      {
        runId: "run_coverage_connector",
        connectionId: target.connectionId,
        claimant: { claimantKind: "connector", claimantId: (await h.services.connectorFeed.detail(target)).pairingId! },
        leaseMs: 1_800_000,
        manualClaimLeasePolicySnapshot: null,
        resolvedPolicy: { maxRowsPerBatch: 100 },
        composedAt: at,
      },
      transportContext,
    );
    expect(connector).not.toBeNull();
    const panel = await h.services.manualSync.readPanel(target);
    expect(panel?.inboundCoverage).toEqual(live);
    expect(panel?.actions).toEqual([]);
  });

  it.each([false, true])(
    "real composed authority survives membership loss and admits both write-only kinds with pause=%s",
    async (paused) => {
      if (paused) await h.pause();
      await assertLive();
      expect((await h.services.connectorFeed.detail(target)).lastSeenAt).toBeNull();
      await h.membership(false);
      await assertLive();
      const panel = await h.services.manualSync.readPanel(target);
      expect(panel?.actions).toEqual(paused ? [] : ["ingest-live", "ingest-staged", "compose"]);
      for (const inbound of inboundKinds()) {
        const first = await h.request("ingest", inbound);
        const duplicate = await h.request("ingest", inbound);
        expect([first.status, duplicate.status]).toEqual([202, 202]);
        expect(await first.text()).toBe("{}");
        expect(await duplicate.text()).toBe("{}");
        expect([...first.headers]).toEqual([...duplicate.headers]);
        const rows = await h.db.query<{ payload: unknown }>(
          `SELECT p.payload FROM channel_connector_inbound_events e
         JOIN channel_connector_inbound_payloads p USING (provider_event_id)
         WHERE e.connection_id=$1 AND e.event_kind=$2 AND e.provider_object_reference=$3`,
          [target.connectionId, inbound.inboundKind, inbound.externalReference],
        );
        expect(rows.rows).toEqual([{ payload: inbound.payload }]);
      }
      h.restart();
      await assertLive();
      expect((await h.request("claim")).status).toBe(403);
      expect((await h.request("report", { reservationId: "absent", outcomes: [] })).status).toBe(403);
      expect((await h.services.connectorFeed.detail(target)).lastSeenAt).toBeNull();
    },
  );

  it.each(["unpair", "revoke", "expire", "disconnect"] as const)(
    "maps %s to dark, never reuses stale pairing truth",
    async (removal) => {
      await assertLive();
      const before = await h.services.connectorFeed.detail(target);
      if (removal === "unpair")
        await h.services.connectorFeed.unpair(target, before.pairingId!, before.revision!, seller);
      if (removal === "revoke") await h.revokeAuthGrant();
      if (removal === "expire") vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
      if (removal === "disconnect") {
        await h.services.connections.disconnectChannelConnection(target, transportContext);
        await h.projectConnection();
      }
      expect(await coverage()).toEqual(dark);
      expect((await h.request("ingest", inboundKinds()[0])).status).not.toBe(202);
      if (removal !== "disconnect") {
        const replacement = await h.pair();
        expect(replacement.pairingId).not.toBe(before.pairingId);
        await assertLive();
        await expect(
          h.services.connectorFeed.unpair(target, before.pairingId!, before.revision!, seller),
        ).rejects.toMatchObject({ code: "conflict" });
        await assertLive();
      }
    },
  );

  it("keeps pending, unpaired and expired pairing codes dark without heartbeat authority", async () => {
    const other = { ...target, connectionId: "connection_pending_7995" };
    await h.services.connections.connectChannel(
      { ...other, providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      transportContext,
    );
    await h.projectConnection(other.connectionId);
    expect((await h.services.manualSync.readPanel(other))?.inboundCoverage).toEqual({
      state: "dark",
      reason: "no-inbound-authority",
    });
    const unpaired = await h.connection("connection_unpaired_7995");
    expect((await h.services.manualSync.readPanel(unpaired))?.inboundCoverage).toEqual({
      state: "dark",
      reason: "no-inbound-authority",
    });
    await h.services.connectorFeed.createPairingCode(unpaired, seller);
    expect((await h.services.manualSync.readPanel(unpaired))?.inboundCoverage).toEqual({
      state: "dark",
      reason: "no-inbound-authority",
    });
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect((await h.services.manualSync.readPanel(unpaired))?.inboundCoverage).toEqual(dark);
  });

  it("negative control: omitting the live source at the actual index.ts composition boundary fails the same live assertion", async () => {
    await assertLive();
    const create = feedRuntime.createConnectorFeedRuntime;
    const omitted = vi.spyOn(feedRuntime, "createConnectorFeedRuntime").mockImplementation((dependencies) => {
      const actual = create(dependencies);
      return {
        ...actual,
        readAuthority: async (input) => ({ ...(await actual.readAuthority(input)), inbound: "absent", grant: null }),
      };
    });
    try {
      h.restart();
      await expect(assertLive()).rejects.toThrow();
    } finally {
      omitted.mockRestore();
      h.restart();
    }
    await assertLive();
  });

  it("seller API authorization is independent of the grantor, with equal foreign/missing refusals and no connector read", async () => {
    const auth = authModule.createServices(h.authDb, {});
    await h.authDb.query(
      `INSERT INTO auth_identity_user_memberships
      (membership_id,user_id,account_id,role_key,role_permissions,status)
      VALUES ('membership_remaining','usr_remaining',$1,'seller','["channels.view"]','active')`,
      [target.accountId],
    );
    for (const userId of [seller.userId, "usr_remaining"]) {
      await auth.sessions.commandHandler({
        streamId: `auth.session-ses_${userId}`,
        command: {
          type: "StartSession",
          sessionId: `ses_${userId}`,
          userId: userId as never,
          accountId: target.accountId,
          availableAccountIds: [target.accountId],
          authenticationMethod: "passkey",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        context: transportContext,
      });
    }
    const app = new Hono<ChannelsApiEnv>();
    app.use("*", async (c, next) => {
      const actor = await resolveActorFromSessionId(auth, c.req.header("x-synthetic-session") ?? "absent");
      if (actor) {
        c.set("actor", actor);
        c.set("context", transportContext);
      }
      await next();
    });
    app.route("/", buildChannelsApi(h.services));
    const request = (userId: string, connectionId = target.connectionId, query = "") =>
      app.request(`/connections/${connectionId}/manual-sync${query}`, {
        headers: { "x-synthetic-session": `ses_${userId}` },
      });
    expect((await request(seller.userId)).status).toBe(200);
    await h.membership(false);
    expect((await request(seller.userId)).status).toBe(401);
    const remaining = await request("usr_remaining");
    expect(remaining.status).toBe(200);
    expect(await remaining.json()).toMatchObject({ inboundCoverage: live });
    await h.connection("connection_foreign_7995", "acc_foreign");
    const missing = await request("usr_remaining", "missing");
    const foreign = await request("usr_remaining", "connection_foreign_7995", "?accountId=acc_foreign&inbound=live");
    expect([missing.status, foreign.status]).toEqual([404, 404]);
    expect(await missing.text()).toBe(await foreign.text());
    const connector = await app.request(`/connections/${target.connectionId}/manual-sync`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(connector.status).toBe(401);
    await assertLive();
  });
});

function inboundKinds(): ConnectorInbound[] {
  const values: Record<string, string> = {
    "TCGplayer Id": "123",
    "Total Quantity": "2",
    "Add to Quantity": "0",
    "TCG Marketplace Price": "1.00",
    Condition: "Near Mint",
  };
  const csv =
    tcgplayerLiveExportHeader.join(",") + "\n" + tcgplayerLiveExportHeader.map((key) => values[key] ?? "").join(",");
  const parsed = parseTcgplayerFullExport({ surface: "live", csv }, { maxRecords: 1 });
  if (parsed.kind !== "parsed") throw new Error("invalid-synthetic-export");
  return [
    {
      inboundKind: "order",
      externalReference: "order.v1:7995",
      payload: { version: 1, records: [{ opaque: "  preserved  ", nested: [1, null, true] }] },
    },
    {
      inboundKind: "export",
      externalReference: "export.v1:7995",
      payload: {
        parsed: { ...parsed, surface: "live" },
        fileSha256: "a".repeat(64),
        capturedAt: new Date().toISOString(),
      },
    },
  ];
}
