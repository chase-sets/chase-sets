import { expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import {
  bootstrapContextDatabase,
  rebuildProjectionGroup,
  resolveModuleProjectionGroups,
  type ContextSubscriptionRunner,
  type ContextSubscriptionStatus,
} from "@chase-sets/bounded-context-runtime";
import { module as channelsModule } from "../../../index";
import { admitConnectorInbound, readAdmittedConnectorInboundEvents } from "../read-model/inbound";
import { connectorInboundSchemaMigrations } from "../read-model/inbound-schema";
import type { ConnectorInbound } from "../domain/transport";
import { describeDb, target, transportContext, transportDatabase } from "./transport-test-support";
import { parseTcgplayerFullExport } from "../../tcgplayer-csv/domain/csv";
import { tcgplayerLiveExportHeader } from "../../tcgplayer-csv/domain/profile";

function order(externalReference = "order.v1:a"): ConnectorInbound {
  return {
    inboundKind: "order",
    externalReference,
    payload: { version: 1, records: [{ order: "opaque", revision: 1, lines: [{ sku: "synthetic", quantity: 2 }] }] },
  };
}
describeDb("connector-ingest-replay / connector-ingest-admission-and-authority", () => {
  const h = transportDatabase("connector_inbound_7994");
  it("admits a concurrent identity/payload exactly once, preserves opaque bytes and is inert after restart", async () => {
    const before = await h.effects();
    const responses = await Promise.all(Array.from({ length: 5 }, () => h.request("ingest", order())));
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("{}");
    }
    expect((await h.db.query("SELECT * FROM channel_connector_inbound_events")).rows).toHaveLength(1);
    const first = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "order",
    });
    expect(first.events[0]?.content).toEqual({ state: "available", payload: order().payload });
    expect(first.completeness).toEqual({ kind: "complete", total: 1 });
    const settled = await h.effects();
    expect(settled.e2).toEqual(before.e2);
    h.restart();
    const repeat = await h.request("ingest", order());
    expect(repeat.status).toBe(202);
    expect(await repeat.text()).toBe("{}");
    expect((await h.effects()).e1).toEqual(settled.e1);
    expect((await h.effects()).e3).toHaveLength(before.e3.length + 6);
  });
  it.each([false, true])("membership-lost ingest remains write-only with seller pause=%s", async (paused) => {
    if (paused) await h.pause();
    await h.membership(false);
    const before = await h.effects();
    for (const operation of ["claim", "report"] as const) {
      const response = await h.request(
        operation,
        operation === "report" ? { reservationId: "cor_absent", outcomes: [] } : {},
      );
      expect(response.status).toBe(403);
    }
    const first = await h.request("ingest", order());
    const admitted = await h.effects();
    const repeat = await h.request("ingest", order());
    expect([first.status, repeat.status]).toEqual([202, 202]);
    expect(await first.text()).toBe(await repeat.text());
    expect([...first.headers]).toEqual([...repeat.headers]);
    expect((await h.effects()).e1).toEqual(admitted.e1);
    expect((await h.effects()).e2).toEqual(before.e2);
    expect((await h.effects()).e3).toHaveLength(before.e3.length + 4);
  });
  it("pins a committed horizon, preserves tie order and expired identities, and excludes later admissions", async () => {
    const at = new Date().toISOString();
    for (let index = 0; index < 5; index++)
      await withPgTransaction(h.db, (db) =>
        admitConnectorInbound(db, target.connectionId, order(`order.v1:${index}`), at),
      );
    const first = await readAdmittedConnectorInboundEvents(h.db, {
      connectionId: target.connectionId,
      inboundKind: "order",
      limit: 2,
    });
    expect(first.completeness).toEqual({ kind: "complete", total: 5 });
    expect(first.nextCursor).not.toBeNull();
    await h.request("ingest", order("order.v1:late"));
    const firstIdentity = first.events[0]?.providerEventId;
    await h.db.query("DELETE FROM channel_connector_inbound_payloads WHERE provider_event_id=$1", [firstIdentity]);
    const replay = await readAdmittedConnectorInboundEvents(h.db, {
      connectionId: target.connectionId,
      inboundKind: "order",
      limit: 2,
    });
    expect(replay.events[0]).toEqual({ ...first.events[0], content: { state: "expired" } });
    const collected = [...first.events];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind: "order",
        after: cursor,
        limit: 2,
      });
      expect(page.horizon).toBe(first.horizon);
      expect(page.completeness).toEqual({ kind: "complete", total: 5 });
      collected.push(...page.events);
      cursor = page.nextCursor;
    }
    expect(collected.map((event) => event.externalReference)).toEqual(
      Array.from({ length: 5 }, (_, index) => `order.v1:${index}`),
    );
    expect(new Set(collected.map((event) => event.sequence)).size).toBe(5);
    const before = await h.effects();
    await h.request("ingest", order("order.v1:0"));
    expect((await h.effects()).e1).toEqual(before.e1);
    expect(
      (await h.db.query("SELECT * FROM channel_connector_inbound_payloads WHERE provider_event_id=$1", [firstIdentity]))
        .rows,
    ).toEqual([]);
  });
  it("keeps identity and payload in the supplied transaction on rollback", async () => {
    const before = await h.effects();
    await expect(
      withPgTransaction(h.db, async (db) => {
        await admitConnectorInbound(db, target.connectionId, order(), new Date().toISOString());
        throw new Error("synthetic-rollback");
      }),
    ).rejects.toThrow("synthetic-rollback");
    expect((await h.effects()).e1).toEqual(before.e1);
  });
  it("reports an independently observed identity-count defect instead of silent completeness", async () => {
    for (let index = 0; index < 3; index++) await h.request("ingest", order(`order.v1:${index}`));
    const first = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "order",
      limit: 1,
    });
    if (!first.nextCursor) throw new Error("missing-fixture-cursor");
    // Synthetic corruption control: production retention never deletes identity.
    await h.db.query("DELETE FROM channel_connector_inbound_payloads WHERE provider_event_id=$1", [
      first.events[0]?.providerEventId,
    ]);
    await h.db.query("DELETE FROM channel_connector_inbound_events WHERE provider_event_id=$1", [
      first.events[0]?.providerEventId,
    ]);
    const page = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "order",
      after: first.nextCursor,
      limit: 1,
    });
    expect(page.completeness).toEqual({ kind: "bounded-incomplete", reason: "identity-count-mismatch" });
  });
  it("does not reuse a cursor across a connection or kind and keeps equal references on different connections distinct", async () => {
    const otherId = "connection_inbound_other";
    await h.connection(otherId);
    const other = await h.pair(otherId);
    for (const externalReference of ["shared-reference", "second-reference"])
      expect((await h.request("ingest", order(externalReference))).status).toBe(202);
    expect(
      (await h.request("ingest", order("shared-reference"), { connectionId: otherId, token: other.token })).status,
    ).toBe(202);
    const input = { connectionId: target.connectionId, inboundKind: "order" as const, limit: 1 };
    const first = await h.services.connectorFeed.readAdmittedConnectorInboundEvents(input);
    if (!first.nextCursor) throw new Error("missing-fixture-cursor");
    for (const scope of [
      { connectionId: otherId, inboundKind: "order" as const },
      { connectionId: target.connectionId, inboundKind: "export" as const },
    ])
      await expect(
        h.services.connectorFeed.readAdmittedConnectorInboundEvents({ ...scope, after: first.nextCursor }),
      ).rejects.toMatchObject({ code: "invalid-input" });
    const otherPage = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: otherId,
      inboundKind: "order",
    });
    expect(otherPage.completeness).toEqual({ kind: "complete", total: 1 });
    expect(otherPage.events[0]?.providerEventId).not.toBe(first.events[0]?.providerEventId);
    expect(otherPage.events[0]?.externalReference).toBe(first.events[0]?.externalReference);
  });
  it("retains admitted payload and read position across repeated boot", async () => {
    await h.request("ingest", order());
    const before = await h.effects();
    await bootstrapContextDatabase(channelsModule, h.db);
    await bootstrapContextDatabase(channelsModule, h.db);
    expect((await h.effects()).e1).toEqual(before.e1);
    h.restart();
    const page = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "order",
    });
    expect(page.completeness).toEqual({ kind: "complete", total: 1 });
    expect(page.events[0]?.content).toEqual({ state: "available", payload: order().payload });
  });
  it("recreates the boot-owned transport shape through its migration alone and resumes inertly", async () => {
    async function shape() {
      return {
        columns: (
          await h.db
            .query(`SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity,generation_expression
          FROM information_schema.columns WHERE table_schema='public' AND
          (table_name IN ('channel_connector_inbound_events','channel_connector_inbound_payloads')
            OR (table_name='channel_connector_pairings' AND column_name='served_poll_window_seconds'))
          ORDER BY table_name,ordinal_position`)
        ).rows,
        indexes: (
          await h.db.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
          AND tablename IN ('channel_connector_inbound_events','channel_connector_inbound_payloads') ORDER BY indexname`)
        ).rows,
      };
    }
    const boot = await shape();
    // Disposable fixture only: remove this slice's empty objects and migration receipt to emulate an older installation.
    await h.db.query("DROP TABLE channel_connector_inbound_payloads, channel_connector_inbound_events");
    await h.db.query("ALTER TABLE channel_connector_pairings DROP COLUMN served_poll_window_seconds");
    await h.db.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id=$1", [
      connectorInboundSchemaMigrations[0]?.migrationId,
    ]);
    const migrationOnly = {
      contextName: "channels",
      schemaSql: "",
      schemaMigrations: connectorInboundSchemaMigrations,
    };
    await bootstrapContextDatabase(migrationOnly, h.db);
    expect(await shape()).toEqual(boot);
    expect((await h.request("ingest", order())).status).toBe(202);
    const before = await h.effects();
    await bootstrapContextDatabase(migrationOnly, h.db);
    await bootstrapContextDatabase(channelsModule, h.db);
    expect(await shape()).toEqual(boot);
    expect((await h.effects()).e1).toEqual(before.e1);
  });
  it("preserves command-owned admission across the declared connection projection reset and repeated replay", async () => {
    expect((await h.request("ingest", order())).status).toBe(202);
    const before = await h.effects();
    const declared = channelsModule.projectionGroups?.find(
      (group) => group.projectionName === "channel-connection-projection",
    );
    if (!declared) throw new Error("missing-connection-projection-group");
    let replayed = false;
    let resetObserved = 0;
    const status: ContextSubscriptionStatus = {
      checkpointKey: "connector-transport-reset",
      subscriptionName: "connector-transport-reset",
      projectionName: declared.projectionName,
      sourceContextName: "channels",
      targetContextName: "channels",
      subscriptionVersion: 1,
      initialized: true,
      lastGlobalPosition: ZERO_GLOBAL_POSITION,
      sourceHeadGlobalPosition: ZERO_GLOBAL_POSITION,
      outstandingEventCount: "0",
      processedEvents: 0,
      state: "caught-up",
      lastError: null,
      blockedStreamCount: 0,
      poisonEventCount: 0,
      updatedAt: new Date().toISOString(),
    };
    const runner: ContextSubscriptionRunner = {
      ...status,
      order: 1,
      async runOnce() {
        if (replayed)
          return { processed: 0, lastGlobalPosition: status.lastGlobalPosition, blockedStreams: 0, poisonEvents: 0 };
        expect((await h.db.query("SELECT 1 FROM channel_connections")).rows).toEqual([]);
        expect((await h.effects()).e1).toEqual(before.e1);
        resetObserved += 1;
        await h.projectConnection();
        replayed = true;
        return { processed: 1, lastGlobalPosition: status.lastGlobalPosition, blockedStreams: 0, poisonEvents: 0 };
      },
      getStatus: () => status,
      refreshStatus: async () => status,
      reset: async () => {
        replayed = false;
      },
      retryBlockedStream: async () => {
        throw new Error("unexpected-retry");
      },
    };
    const [group] = resolveModuleProjectionGroups(
      [
        {
          contextName: "channels",
          module: { ...channelsModule, buildProjectionGroups: undefined, projectionGroups: [declared] },
          services: h.services,
          pool: h.db,
          projectionHandlerSets: [],
        },
      ],
      [runner],
    );
    if (!group) throw new Error("missing-resolved-projection-group");
    await rebuildProjectionGroup(group);
    await rebuildProjectionGroup(group);
    expect(resetObserved).toBe(2);
    h.restart();
    expect((await h.request("ingest", order())).status).toBe(202);
    const after = await h.effects();
    expect(after.e1).toEqual(before.e1);
    expect(after.e2).toEqual(before.e2);
    expect(after.e3).toHaveLength(before.e3.length + 1);
    expect(
      await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind: "order",
      }),
    ).toMatchObject({
      events: [{ content: { state: "available", payload: order().payload } }],
      completeness: { kind: "complete", total: 1 },
    });
  });
  it("keeps the same pinned page cursor, horizon and total after payload expiry", async () => {
    for (let index = 0; index < 4; index++) await h.request("ingest", order(`order.v1:${index}`));
    const first = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "order",
      limit: 1,
    });
    if (!first.nextCursor) throw new Error("missing-fixture-cursor");
    const input = {
      connectionId: target.connectionId,
      inboundKind: "order" as const,
      limit: 1,
      after: first.nextCursor,
    };
    const before = await h.services.connectorFeed.readAdmittedConnectorInboundEvents(input);
    await h.db.query("DELETE FROM channel_connector_inbound_payloads WHERE provider_event_id=$1", [
      before.events[0]?.providerEventId,
    ]);
    h.restart();
    expect(await h.services.connectorFeed.readAdmittedConnectorInboundEvents(input)).toEqual({
      ...before,
      events: before.events.map((event) => ({ ...event, content: { state: "expired" } })),
    });
  });
  it("cannot advance a horizon past an admission that has allocated its sequence but not committed", async () => {
    await h.request("ingest", order("order.v1:first"));
    const writer = await h.db.connect();
    let read: ReturnType<typeof h.services.connectorFeed.readAdmittedConnectorInboundEvents> | undefined;
    try {
      await writer.query("BEGIN");
      await admitConnectorInbound(writer, target.connectionId, order("order.v1:late-commit"), new Date().toISOString());
      read = h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind: "order",
        limit: 1,
      });
      await expect
        .poll(
          async () =>
            (
              await h.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock_shared%' AND pid<>pg_backend_pid()`)
            ).rows.length,
        )
        .toBeGreaterThan(0);
      await writer.query("COMMIT");
      const first = await read;
      expect(first.completeness).toEqual({ kind: "complete", total: 2 });
      if (!first.nextCursor) throw new Error("missing-fixture-cursor");
      const second = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
        connectionId: target.connectionId,
        inboundKind: "order",
        after: first.nextCursor,
        limit: 1,
      });
      expect(second.events.map((event) => event.externalReference)).toEqual(["order.v1:late-commit"]);
      expect(second.completeness).toEqual({ kind: "complete", total: 2 });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      if (read) await read;
    }
  });
  it("keeps kind-qualified identities distinct and exports the derived payload verbatim after restart", async () => {
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
    if (parsed.kind !== "parsed") throw new Error("invalid-fixture-export");
    const payload = { parsed, fileSha256: "a".repeat(64), capturedAt: new Date().toISOString() };
    expect((await h.request("ingest", order("same-reference"))).status).toBe(202);
    expect(
      (await h.request("ingest", { inboundKind: "export", externalReference: "same-reference", payload })).status,
    ).toBe(202);
    h.restart();
    const page = await h.services.connectorFeed.readAdmittedConnectorInboundEvents({
      connectionId: target.connectionId,
      inboundKind: "export",
    });
    expect(page.completeness).toEqual({ kind: "complete", total: 1 });
    expect(page.events[0]?.content).toEqual({ state: "available", payload });
    expect((await h.db.query("SELECT * FROM channel_inventory_snapshots")).rows).toEqual([]);
    const before = await h.effects();
    for (const invalid of [
      csv,
      { ...payload, parsed: { ...parsed, surface: "staged" } },
      { ...payload, parsed: { kind: "refused", reason: "empty-export" } },
      { ...payload, secret: "payload-secret-sentinel" },
    ]) {
      const response = await h.request("ingest", {
        inboundKind: "export",
        externalReference: "invalid",
        payload: invalid,
      });
      expect(response.status).toBe(400);
      expect((await h.effects()).e1).toEqual(before.e1);
      expect((await h.effects()).e2).toEqual(before.e2);
    }
    expect(JSON.stringify((await h.effects()).e3)).not.toContain("payload-secret-sentinel");
  });
  it("connector-feed-scope-isolation: same-account foreign, cross-account pending and nonexistent targets are indistinguishable", async () => {
    await h.connection("same_account_other");
    await h.services.connections.connectChannel(
      { accountId: "acc_other", connectionId: "other_account_pending", providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      { ...transportContext, audit: { ...transportContext.audit, forAccountId: "acc_other" } },
    );
    const before = await h.effects();
    const results = [];
    for (const connectionId of ["same_account_other", "other_account_pending", "nonexistent"]) {
      const response = await h.request("ingest", order(), { connectionId });
      results.push({ status: response.status, body: await response.text(), headers: [...response.headers] });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]?.status).toBe(403);
    expect((await h.effects()).e1).toEqual(before.e1);
    expect((await h.effects()).e2).toEqual(before.e2);
    expect((await h.effects()).e3).toHaveLength(before.e3.length + 3);
  });
});
