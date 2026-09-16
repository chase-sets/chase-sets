import { expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { context, describeDb, healthDatabase } from "../../connection-health/tests/test-support";
import { healthDigest } from "../../connection-health/domain/identity";
import { writeHealthSnapshot } from "../../connection-health/read-model/store";
import { decodeChannelAttentionFact } from "../domain/codecs";
import { createConnectionAttentionRuntime } from "../api/runtime";
import { recordAttentionHealthTransition } from "../api/lifecycle";
import { createChannelActionAttentionSourceFromReadModel } from "../read-model/attention-source";
import { createChannelProviderRegistry } from "../../publication-port/api/registry";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import { toTransportEvent } from "@chase-sets/event-core/transport";

describeDb("channel-attention-lifecycle", () => {
  const h = healthDatabase("attention_lifecycle");
  const command = (connectionId: string, generation = 1) => ({
    connection: h.query(connectionId),
    reasonCode: "polling" as const,
    generation,
    resolutionReason: "handled-on-channel" as const,
  });
  const facts = async (id: string) =>
    (
      await h.db.query<{ payload: unknown; event_type: string }>(
        "SELECT payload,event_type FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version",
        [`channels.connection-attention-${id}`],
      )
    ).rows;

  it("claimed-reconcile-staleness publishes age attention through the composed runtime and withdraws only drift", async () => {
    const id = "synthetic_claimed_age_attention";
    await h.services.connections.connectChannel(
      { ...h.query(id), providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      context,
    );
    await h.services.connections.activateChannelConnection(
      { ...h.query(id), bindings: [{ storageLocationId: "location_health", revision: 1 }] },
      context,
    );
    const handlers = buildChannelConnectionProjectionHandlers(h.db);
    const events = await createPostgresEventStore({ pool: h.db }).readStream({
      streamId: `channels.connection-${id}`,
      fromVersion: 1,
    });
    for (const event of events) await handlers[event.eventType]?.(toTransportEvent(event));
    await h.db.query(
      `INSERT INTO channel_sync_runs
      (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
       manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at,last_stream_version)
      VALUES ('synthetic-age-manual',1,1,$1,'tcgplayer','synthetic-age-reservation','manual','synthetic-manual',
        '2027-01-01T00:00:00Z','{}','composed','synthetic-basis',1,'[]',1,$2,now(),now(),1)`,
      [id, "a".repeat(64)],
    );
    const manual = (await h.db.query("SELECT * FROM channel_sync_runs WHERE connection_id=$1", [id])).rows;
    const registry = createChannelProviderRegistry([
      {
        identity: { providerKey: "tcgplayer", environment: "sandbox" },
        setup: {
          providerKey: "tcgplayer",
          environment: "sandbox",
          requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
        },
        publication: { execution: "claimed" },
      },
    ]);
    const input = {
      connectionId: id,
      registry,
      sourceAttempt: 1,
      healthAuthority: (await h.services.connectionHealth.readConnectionHealth(h.query(id))).health,
    };
    await h.services.connectionHealth.submitObservation(await h.observation(id, "polling"), context);
    await h.services.reconciliation.reconcileConnection(input, context);
    expect(
      await h.services.reconciliation.deliverHealthObservations(h.services.connectionHealth, () => context),
    ).toEqual({ consumed: 1 });
    const source = createChannelActionAttentionSourceFromReadModel(h.db);
    const queue = () => source.load({ accountId: context.audit.forAccountId, now: new Date().toISOString() });
    expect((await queue()).filter((item) => item.id === `channel-action:${id}`)).toHaveLength(1);
    expect(
      (await h.services.connectionAttention.listOpenAttention(h.query(id)))[0].health
        .map((reason) => reason.reasonCode)
        .sort(),
    ).toEqual(["drift", "polling"]);
    const at = new Date();
    for (const generation of [1, 2])
      await h.db.query(
        `INSERT INTO channel_inventory_snapshots
      (snapshot_id,snapshot_generation,connection_id,provider_key,surface,parsed_row_count,completeness,ingested_at,captured_at,captured_at_source)
      VALUES ($1,$2,$3,'tcgplayer','live',1,'unverified',$4,$5,'operator-declared')`,
        [
          `synthetic-attention-age-${generation}`,
          generation,
          id,
          at.toISOString(),
          new Date(at.getTime() - (3 - generation) * 1000).toISOString(),
        ],
      );
    await h.services.reconciliation.reconcileConnection(input, context);
    await h.services.reconciliation.deliverHealthObservations(h.services.connectionHealth, () => context);
    await h.services.reconciliation.reconcileConnection(input, context);
    await h.services.reconciliation.deliverHealthObservations(h.services.connectionHealth, () => context);
    expect(
      (await h.services.connectionAttention.listOpenAttention(h.query(id)))[0].health.map(
        (reason) => reason.reasonCode,
      ),
    ).toEqual(["polling"]);
    expect((await queue()).filter((item) => item.id === `channel-action:${id}`)).toHaveLength(1);
    expect(
      (await h.services.reconciliation.readChannelDriftAttentionContribution({ connectionId: id }))?.resolution,
    ).toBeNull();
    expect((await h.db.query("SELECT * FROM channel_sync_runs WHERE connection_id=$1", [id])).rows).toEqual(manual);
    await h.db.query("DELETE FROM channel_sync_runs WHERE run_id='synthetic-age-manual' AND connection_id=$1", [id]);
  });

  it("opens once, resolves once without closing health, and reopens only a changed generation", async () => {
    const id = await h.connection();
    const first = await h.observation(id);
    await h.services.connectionHealth.submitObservation(first, context);
    await h.services.connectionHealth.submitObservation(first, context);
    expect((await facts(id)).map((row) => decodeChannelAttentionFact(row.payload).schemaVersion)).toEqual([
      "ChannelAttentionOpened/v1",
    ]);
    expect(await h.services.connectionAttention.resolveAttention(command(id), context)).toEqual({
      outcome: "resolved",
    });
    expect(await h.services.connectionAttention.resolveAttention(command(id), context)).toEqual({ outcome: "inert" });
    expect((await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0].state).toBe("degraded");
    expect(
      await h.services.connectionAttention.listOpenAttention({ accountId: context.audit.forAccountId }),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ connectionId: id })]));
    await h.services.connectionHealth.submitObservation(
      { ...first, sourceAttempt: 2, fingerprint: healthDigest("attention-new-generation") },
      context,
    );
    expect(await h.services.connectionAttention.resolveAttention(command(id), context)).toEqual({ outcome: "stale" });
    const reopened = (
      await h.services.connectionAttention.listOpenAttention({ accountId: context.audit.forAccountId })
    ).find((row) => row.connectionId === id);
    expect(reopened?.health).toEqual([expect.objectContaining({ generation: 2 })]);
    expect((await facts(id)).map((row) => decodeChannelAttentionFact(row.payload).schemaVersion)).toEqual([
      "ChannelAttentionOpened/v1",
      "ChannelAttentionResolved/v1",
      "ChannelAttentionOpened/v1",
    ]);
  });

  it("automatically resolves matching success once and retains a later changed generation", async () => {
    const id = await h.connection();
    const first = await h.observation(id);
    await h.services.connectionHealth.submitObservation(first, context);
    const success = { ...first, resultOrdinal: 2, outcome: "success" as const };
    await h.services.connectionHealth.submitObservation(success, context);
    await h.services.connectionHealth.submitObservation(success, context);
    expect((await facts(id)).map((row) => decodeChannelAttentionFact(row.payload).resolutionReason)).toEqual([
      null,
      "recovered-automatically",
    ]);
    const closed = (await h.services.connectionHealth.readConnectionHealth(h.query(id))).health.reasons[0];
    await h.services.connectionHealth.submitObservation(
      { ...first, sourceAttempt: 2, fingerprint: healthDigest("after-recovery") },
      context,
    );
    await recordAttentionHealthTransition(h.db, createPostgresEventStore({ pool: h.db }), h.query(id), closed, context);
    expect(await facts(id)).toHaveLength(3);
    expect(
      (await h.services.connectionAttention.listOpenAttention({ accountId: context.audit.forAccountId })).find(
        (row) => row.connectionId === id,
      )?.health[0].generation,
    ).toBe(2);
  });

  it("serializes concurrent resolutions with one fact and no cross-context event or manual write", async () => {
    const id = await h.connection();
    await h.services.connectionHealth.submitObservation(await h.observation(id, "sale-follow-up"), context);
    const before = (await h.db.query<{ count: string }>("SELECT count(*)::text FROM event_store_events")).rows[0].count;
    const input = {
      ...command(id),
      reasonCode: "sale-follow-up" as const,
      resolutionReason: "inventory-adjusted-separately" as const,
    };
    const outcomes = await Promise.all([
      h.services.connectionAttention.resolveAttention(input, context),
      h.services.connectionAttention.resolveAttention(input, context),
    ]);
    expect(outcomes.map((row) => row.outcome).sort()).toEqual(["inert", "resolved"]);
    expect((await h.db.query<{ count: string }>("SELECT count(*)::text FROM event_store_events")).rows[0].count).toBe(
      String(Number(before) + 1),
    );
    expect(
      (
        await h.db.query(
          "SELECT 1 FROM event_store_events WHERE event_type ~ '^(inventory|ordering|fulfillment|payments)\\.'",
        )
      ).rows,
    ).toHaveLength(0);
    expect((await h.db.query("SELECT 1 FROM channel_sync_runs")).rows).toHaveLength(0);
    expect((await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0].state).toBe("degraded");
  });

  it("rejects a real newer generation committed between owner read and resolution write", async () => {
    const id = await h.connection();
    const first = await h.observation(id);
    await h.services.connectionHealth.submitObservation(first, context);
    let signal!: () => void;
    let proceed!: () => void;
    const read = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const release = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const db: PgTransactionalPool = {
      query: h.db.query.bind(h.db),
      connect: async () => {
        const client = await h.db.connect();
        return {
          query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
            if (typeof sql === "string" && sql.includes("SELECT stream_id")) {
              signal();
              await release;
            }
            return client.query<Row>(sql, params);
          },
          release: () => client.release(),
        };
      },
    };
    const runtime = createConnectionAttentionRuntime({
      db,
      eventStore: createPostgresEventStore({ pool: h.db }),
      connectionHealth: h.services.connectionHealth,
    });
    const pending = runtime.resolveAttention(command(id), context);
    try {
      await read;
      await h.services.connectionHealth.submitObservation(
        { ...first, sourceAttempt: 2, fingerprint: healthDigest("interleaved") },
        context,
      );
    } finally {
      proceed();
    }
    expect(await pending).toEqual({ outcome: "stale" });
    expect((await facts(id)).map((row) => decodeChannelAttentionFact(row.payload).schemaVersion)).toEqual([
      "ChannelAttentionOpened/v1",
      "ChannelAttentionOpened/v1",
    ]);
    const source = createChannelActionAttentionSourceFromReadModel(h.db);
    expect(
      (await source.load({ accountId: context.audit.forAccountId, now: new Date().toISOString() })).find(
        (item) => item.id === `channel-action:${id}`,
      )?.summary.code,
    ).toBe("channel-action-open");
  });

  it("channel-action-account-isolation rejects foreign reads and resolution", async () => {
    const id = await h.connection();
    await h.services.connectionHealth.submitObservation(await h.observation(id), context);
    expect(await h.services.connectionAttention.listOpenAttention({ accountId: "acc_foreign" })).toEqual([]);
    await expect(
      h.services.connectionAttention.resolveAttention(
        { ...command(id), connection: { connectionId: id, accountId: "acc_foreign" } },
        context,
      ),
    ).rejects.toThrow("connection-not-found");
    await expect(
      h.services.connectionAttention.listOpenAttention({ connectionId: id, accountId: "acc_foreign" }),
    ).rejects.toThrow("connection-not-found");
  });

  it("fences a stale opening writer even when its old generation row is absent", async () => {
    const id = await h.connection();
    const first = await h.observation(id);
    await h.services.connectionHealth.submitObservation(first, context);
    const captured = (await h.services.connectionHealth.listOpenReasonGenerations(h.query(id)))[0];
    // A synthetic pre-attention upgrade state has health but no attention row.
    const removed = await h.db.query(
      `DELETE FROM channel_connection_attention WHERE connection_id=$1 AND account_id=$2 AND reason_code='polling' AND reason_generation=1 AND fingerprint=$3 AND resolved_at IS NULL RETURNING connection_id`,
      [id, context.audit.forAccountId, captured.fingerprint],
    );
    expect(removed.rows).toHaveLength(1);
    await h.services.connectionHealth.submitObservation(
      { ...first, sourceAttempt: 2, fingerprint: healthDigest("new-before-old-open") },
      context,
    );
    const before = await facts(id);
    await recordAttentionHealthTransition(
      h.db,
      createPostgresEventStore({ pool: h.db }),
      h.query(id),
      captured,
      context,
    );
    expect(await facts(id)).toEqual(before);
    expect(
      (
        await h.db.query(
          "SELECT reason_generation::text AS generation FROM channel_connection_attention WHERE connection_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ generation: "2" }]);
  });

  it("fences stale automatic recovery while the old attention row is still unresolved", async () => {
    const id = await h.connection();
    const first = await h.observation(id);
    await h.services.connectionHealth.submitObservation(first, context);
    const previous = (await h.services.connectionHealth.readConnectionHealth(h.query(id))).health;
    const closed = { ...previous.reasons[0], state: "closed" as const };
    // Exercise the write-back seam directly, before any attention resolution has run.
    expect(await writeHealthSnapshot(h.db, id, previous, { ...previous, reasons: [closed] })).toBe(1);
    await h.services.connectionHealth.submitObservation(
      { ...first, sourceAttempt: 2, fingerprint: healthDigest("new-before-old-recovery") },
      context,
    );
    const before = await facts(id);
    await recordAttentionHealthTransition(h.db, createPostgresEventStore({ pool: h.db }), h.query(id), closed, context);
    expect(await facts(id)).toEqual(before);
    expect(
      (
        await h.db.query(
          "SELECT resolved_at FROM channel_connection_attention WHERE connection_id=$1 AND reason_generation=1",
          [id],
        )
      ).rows,
    ).toEqual([{ resolved_at: null }]);
  });
});
