import { expect, it } from "vitest";
import { Hono } from "hono";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { aggregateSellerAttentionQueue } from "@chase-sets/seller-attention-queue";
import { context, describeDb, healthDatabase } from "../../connection-health/tests/test-support";
import { buildChannelConnectionProjectionHandlers } from "../../connections/read-model/projection";
import { readManualAttentionContributions } from "../../manual-sync/read-model/attention-query";
import { createChannelActionAttentionSourceFromReadModel } from "../read-model/attention-source";

describeDb("channel-action canonical bounded page", () => {
  const h = healthDatabase("attention_page");
  async function seedManualPage(accountId: string, prefix: string, count: number) {
    await h.db.query(
      `INSERT INTO channel_connections
      (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,projection_updated_at,last_stream_version)
      SELECT $2 || lpad(n::text,3,'0'),$1,'tcgplayer','sandbox','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1
      FROM generate_series(1,$3::int) n`,
      [accountId, prefix, count],
    );
    await h.db.query(
      `INSERT INTO channel_sync_runs
      (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
       manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at,last_stream_version)
      SELECT $1 || n,1,1,$1 || lpad(n::text,3,'0'),'tcgplayer',$1 || n,'manual','synthetic-manual',
        '2027-01-01T00:00:00Z','{}','composed','synthetic-basis',1,'[]',1,$2,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1
      FROM generate_series(1,$3::int) n`,
      [prefix, "a".repeat(64), count],
    );
  }
  async function loadPage(accountId: string) {
    let count = 0;
    const items = await createChannelActionAttentionSourceFromReadModel({
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        count++;
        return h.db.query<Row>(sql, params);
      },
    }).load({ accountId, now: "2026-09-13T01:00:00Z" });
    expect(items).toHaveLength(100);
    expect(new Set(items.map((item) => item.id)).size).toBe(100);
    expect(count).toBe(4);
    return items;
  }
  it("keeps a newer critical health item ahead of 100 older manual-ready info connections", async () => {
    await seedManualPage(context.audit.forAccountId, "synthetic-critical-page-", 100);
    const id = await h.connection();
    const failure = await h.observation(id, "polling", { occurredAt: "2026-09-13T00:00:00Z" });
    for (const sourceAttempt of [1, 2, 3])
      await h.services.connectionHealth.submitObservation({ ...failure, sourceAttempt }, context);
    const items = await loadPage(context.audit.forAccountId);
    expect(items[0]).toMatchObject({ id: `channel-action:${id}`, severity: "critical", dueAt: null });
    expect(items.filter((item) => item.severity === "info")).toHaveLength(99);
    expect(items.some((item) => item.id === "channel-action:synthetic-critical-page-100")).toBe(false);
  });
  it("bounds equal severity by earliest observation then connection ID", async () => {
    const accountId = "acc_synthetic_tie_page";
    const prefix = "synthetic-tie-page-";
    await seedManualPage(accountId, prefix, 101);
    await h.db.query(
      `UPDATE channel_sync_runs SET updated_at='2025-12-01T00:00:00Z',revision=revision+1
      WHERE connection_id=$1 AND revision=1 AND state='composed'`,
      [`${prefix}101`],
    );
    const items = await loadPage(accountId);
    expect(items.every((item) => item.severity === "info" && item.dueAt === null)).toBe(true);
    expect(items.map((item) => item.id)).toEqual([
      `channel-action:${prefix}101`,
      ...Array.from({ length: 99 }, (_, index) => `channel-action:${prefix}${String(index + 1).padStart(3, "0")}`),
    ]);
    expect(items[0].observedAt).toBe("2025-12-01T00:00:00.000Z");
  });
});

describeDb("channel-action-source-contract", () => {
  const h = healthDatabase("attention_source");
  const queueContext = () => ({ accountId: context.audit.forAccountId, now: new Date().toISOString() });
  async function project(id: string) {
    const handlers = buildChannelConnectionProjectionHandlers(h.db);
    for (const event of await createPostgresEventStore({ pool: h.db }).readStream({
      streamId: `channels.connection-${id}`,
    }))
      await handlers[event.eventType](toTransportEvent(event));
  }
  async function manual(
    id: string,
    state: "composed" | "application-unknown" | "applied",
    sequence = 1,
    recovery = false,
  ) {
    const run = `synthetic-${id}-${sequence}`;
    await h.db.query(
      `INSERT INTO channel_sync_runs
      (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
       manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at,last_stream_version)
      VALUES ($1,1,$2,$3,'tcgplayer',$1,'manual','synthetic-manual','2027-01-01T00:00:00Z','{}',$4,'synthetic-basis',1,'[]',1,$5,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',1)`,
      [run, sequence, id, state, "a".repeat(64)],
    );
    if (recovery)
      await h.db.query(
        `INSERT INTO channels_manual_sync_clamp_status
      (run_id,connection_id,account_id,run_revision,state,requested_listing_count,affected_listing_count,updated_at)
      VALUES ($1,$2,$3,1,'recovery',1,1,'2026-09-02T00:00:00Z')`,
        [run, id, context.audit.forAccountId],
      );
    return run;
  }
  it.each([
    { state: "composed" as const, recovery: false, reason: "ready", severity: "info" },
    { state: "application-unknown" as const, recovery: false, reason: "unknown", severity: "warning" },
    { state: "application-unknown" as const, recovery: true, reason: "recovery", severity: "warning" },
  ])("preserves real manual-only $reason, latest eligible run and pg Date normalization", async (scenario) => {
    const id = await h.connection();
    await project(id);
    await manual(id, scenario.state, 1, scenario.recovery);
    await manual(id, "applied", 2);
    const rows = await readManualAttentionContributions(h.db, context.audit.forAccountId, [id]);
    expect(rows).toEqual([
      {
        connectionId: id,
        reason: scenario.reason,
        observedAt: scenario.recovery ? "2026-09-02T00:00:00.000Z" : "2026-09-01T00:00:00.000Z",
      },
    ]);
    const item = (await createChannelActionAttentionSourceFromReadModel(h.db).load(queueContext())).find(
      (item) => item.id === `channel-action:${id}`,
    );
    expect(item).toMatchObject({
      severity: scenario.severity,
      summary: { code: `channel-${scenario.reason}`, params: { connectionId: id } },
      dueAt: null,
      deepLink: { href: `/account/channels/${id}` },
    });
  });
  it("retains exactly one mixed item, health-only counts, and independent contribution endings", async () => {
    const id = await h.connection();
    await project(id);
    const run = await manual(id, "composed");
    const first = await h.observation(id);
    for (const sourceAttempt of [1, 2, 3])
      await h.services.connectionHealth.submitObservation({ ...first, sourceAttempt }, context);
    const source = createChannelActionAttentionSourceFromReadModel(h.db);
    const item = async () => (await source.load(queueContext())).filter((item) => item.id === `channel-action:${id}`);
    expect(await item()).toEqual([
      expect.objectContaining({
        severity: "critical",
        observedAt: "2026-09-01T00:00:00.000Z",
        summary: {
          code: "channel-action-open",
          params: { reasonCount: 1, topReason: "polling", manualReason: "ready", connectionId: id },
        },
      }),
    ]);
    await h.services.connectionAttention.resolveAttention(
      { connection: h.query(id), reasonCode: "polling", generation: 1, resolutionReason: "no-action-required" },
      context,
    );
    expect((await item())[0].summary.code).toBe("channel-ready");
    await h.services.connectionHealth.submitObservation(
      { ...first, sourceAttempt: 4, fingerprint: "b".repeat(64) },
      context,
    );
    await h.db.query(
      "UPDATE channel_sync_runs SET state='applied',revision=revision+1 WHERE run_id=$1 AND revision=1 AND state='composed'",
      [run],
    );
    expect((await item())[0].summary).toEqual({
      code: "channel-action-open",
      params: { reasonCount: 1, topReason: "polling" },
    });
    await h.services.connectionAttention.resolveAttention(
      { connection: h.query(id), reasonCode: "polling", generation: 2, resolutionReason: "no-action-required" },
      context,
    );
    expect(await item()).toEqual([]);
    expect(
      (
        await h.services.connectionAttention.listOpenAttention({
          connectionId: id,
          accountId: context.audit.forAccountId,
        })
      )[0],
    ).toMatchObject({ health: [], manual: null });
  });
  it("channel-attention-real-composition-contract serves and resolves the same account query through the real API", async () => {
    const id = await h.connection();
    await project(id);
    await h.services.connectionHealth.submitObservation(await h.observation(id), context);
    const services = h.services;
    const app = new Hono<ChannelsApiEnv>();
    let permissions: readonly string[] = ["channels.view", "channels.manage"];
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: context.audit.forAccountId, permissions });
      c.set("context", context);
      await next();
    });
    app.route("/api/channels", buildChannelsApi(services));
    const url = `http://local/api/channels/connections/${id}/attention`;
    expect(await (await app.request(url)).json()).toEqual(
      (await services.connectionAttention.listOpenAttention({ ...h.query(id) }))[0],
    );
    permissions = ["channels.view"];
    const request = () => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasonCode: "polling", generation: 1, resolutionReason: "handled-on-channel" }),
    });
    expect((await app.request(`${url}/resolve`, request())).status).toBe(403);
    permissions = ["channels.view", "channels.manage"];
    expect(await (await app.request(`${url}/resolve`, request())).json()).toEqual({ outcome: "resolved" });
    expect(await (await app.request(url)).json()).toMatchObject({ health: [], manual: null });
    expect(await services.connectionHealth.listOpenReasonGenerations(h.query(id))).toHaveLength(1);
  });
  it("unions connection keys before 100 and batches with no per-item I/O", async () => {
    // Synthetic producer projection rows exercise the real account query, not provider acceptance.
    await h.db.query(
      `INSERT INTO channel_connections (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,projection_updated_at,last_stream_version)
      SELECT 'page-' || n,$1,'tcgplayer','sandbox','active','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',1 FROM generate_series(1,101) n`,
      [context.audit.forAccountId],
    );
    for (let n = 1; n <= 101; n++) await manual(`page-${n}`, "composed");
    const healthId = await h.connection();
    await h.services.connectionHealth.submitObservation(
      await h.observation(healthId, "polling", { occurredAt: "2026-08-01T00:00:00Z" }),
      context,
    );
    let count = 0;
    const source = createChannelActionAttentionSourceFromReadModel({
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        count++;
        return h.db.query<Row>(sql, params);
      },
    });
    const items = await source.load(queueContext());
    expect(items).toHaveLength(100);
    expect(new Set(items.map((item) => item.id)).size).toBe(100);
    expect(count).toBe(4);
    expect(items.some((item) => item.id === `channel-action:${healthId}`)).toBe(true);
  });
  it.each(["channel_sync_runs", "channel_connection_health"])(
    "degrades only channel-action on the %s owner-read failure",
    async (table) => {
      const source = createChannelActionAttentionSourceFromReadModel({
        query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
          if (typeof sql === "string" && sql.includes(table)) throw new Error("synthetic-owner-unavailable");
          return h.db.query<Row>(sql, params);
        },
      });
      const queue = await aggregateSellerAttentionQueue([source], queueContext());
      expect(queue.sources).toEqual([expect.objectContaining({ id: "channel-action", status: "unavailable" })]);
      expect(queue.items).toEqual([]);
    },
  );
});
