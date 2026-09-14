import { expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { context, describeDb, healthDatabase } from "../../connection-health/tests/test-support";
import { healthDigest } from "../../connection-health/domain/identity";
import { writeHealthSnapshot } from "../../connection-health/read-model/store";
import { decodeChannelAttentionFact } from "../domain/codecs";
import { createConnectionAttentionRuntime } from "../api/runtime";
import { recordAttentionHealthTransition } from "../api/lifecycle";
import { createChannelActionAttentionSourceFromReadModel } from "../read-model/attention-source";

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
