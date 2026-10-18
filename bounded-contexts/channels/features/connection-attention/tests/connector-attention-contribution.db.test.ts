import { createHash } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { context, describeDb, healthDatabase } from "../../connection-health/tests/test-support";
import { createChannelActionAttentionSourceFromReadModel } from "../read-model/attention-source";
import { readConnectionAttention } from "../read-model/query";

// Synthetic producer projection rows exercise the real attention read; no provider is contacted.
describeDb("connector-attention-contribution", () => {
  const h = healthDatabase("connector_attention");
  const accountId = context.audit.forAccountId;
  const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 10, minute)).toISOString();
  type Operation = Readonly<{
    generation: number;
    status: "pending" | "in-flight" | "succeeded" | "failed";
    outcome?: Readonly<Record<string, unknown>>;
    terminalAt?: string;
    firstClaimedAt?: string;
  }>;
  const tables = {
    export: { table: "channel_live_export_operations", kind: "tcgplayer-live-export", id: "cxp", work: "cxpl" },
    pull: { table: "channel_order_pull_operations", kind: "tcgplayer-order-pull", id: "cop", work: "copl" },
  } as const;
  const workColumn = { export: "export_id", pull: "pull_id" } as const;

  async function connection(connectionId: string, owner = accountId) {
    await h.db.query(
      `INSERT INTO channel_connections (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,projection_updated_at,last_stream_version)
      VALUES ($1,$2,'tcgplayer','sandbox','active','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',1)`,
      [connectionId, owner],
    );
    return connectionId;
  }
  async function operation(kind: keyof typeof tables, connectionId: string, row: Operation) {
    const { table, kind: operationKind, id, work } = tables[kind];
    const operationId = `${id}_${digest(`${kind}:${connectionId}:${row.generation}`).slice(0, 40)}`;
    const inFlight = row.status === "in-flight";
    await h.db.query(
      `INSERT INTO ${table} (operation_id,connection_id,operation_kind,${workColumn[kind]},schedule_generation,payload,
        payload_digest,status,revision,attempt_id,claim_generation,claimant_kind,claim_owner_id,reservation_id,claimed_until,
        attempt_count,outcome,enqueued_at,first_claimed_at,terminal_at)
      VALUES ($1,$2,$3,$4,$5,'{}',$6,$7,1,$8,$9,$10,$11,$12,$13,$18,$14::jsonb,$15,$16,$17)`,
      [
        operationId,
        connectionId,
        operationKind,
        `${work}_${digest(`${operationId}:work`).slice(0, 40)}`,
        row.generation,
        digest(`${operationId}:payload`),
        row.status,
        inFlight ? `attempt-${operationId}` : null,
        row.status === "pending" ? 0 : 1,
        inFlight ? "connector" : null,
        inFlight ? "pair_synthetic" : null,
        inFlight ? `reservation-${operationId}` : null,
        inFlight ? "2027-01-01T00:00:00Z" : null,
        row.outcome ? JSON.stringify(row.outcome) : null,
        at(0),
        row.firstClaimedAt ?? (row.status === "pending" ? null : at(0)),
        row.terminalAt ?? null,
        row.status === "pending" ? 0 : 1,
      ],
    );
    return operationId;
  }
  const complete = { export: { kind: "live-export-complete" }, pull: { kind: "order-pull-complete" } } as const;
  const unknown = (kind: keyof typeof tables, reason: string) => ({
    kind: kind === "export" ? "live-export-unknown" : "order-pull-unknown",
    reason,
  });
  const terminal = (
    kind: keyof typeof tables,
    generation: number,
    minute: number,
    outcome: Readonly<Record<string, unknown>> = complete[kind],
  ) =>
    ({
      generation,
      status: outcome === complete[kind] ? "succeeded" : "failed",
      outcome,
      terminalAt: at(minute),
    }) as const;
  async function batch(
    connectionId: string,
    sequence: number,
    state: string,
    claimant: "connector" | "manual",
    created: string,
    updated = created,
  ) {
    const runId = `run_${digest(`${connectionId}:${sequence}`).slice(0, 16)}`;
    await h.db.query(
      `INSERT INTO channel_sync_runs
      (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
       manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at,last_stream_version)
      VALUES ($1,1,$2,$3,'tcgplayer',$4,$5,'synthetic-claimant','2027-01-01T00:00:00Z',$6::jsonb,$7,'synthetic-basis',1,'[]',1,$8,$9,$10,1)`,
      [
        runId,
        sequence,
        connectionId,
        `reservation-${runId}`,
        claimant,
        claimant === "manual" ? "{}" : null,
        state,
        "a".repeat(64),
        created,
        updated,
      ],
    );
    return runId;
  }
  const read = async (connectionId: string) =>
    (await h.services.connectionAttention.listOpenAttention({ accountId, connectionId }))[0]!;
  const connectorOf = async (connectionId: string) => (await read(connectionId)).connector;

  it("AC1 sign-in-needed follows the newest terminal live-export or order-pull outcome", async () => {
    const id = await connection("connector-sign-in");
    await operation("export", id, terminal("export", 1, 1));
    const lost = await operation("export", id, terminal("export", 2, 2, unknown("export", "session-lost")));
    expect(await connectorOf(id)).toMatchObject({
      signInNeeded: true,
      unknownOutcomes: [{ kind: "live-export", idSuffix: lost.slice(-4), reason: "session-lost", at: at(2) }],
    });
    // A newer terminal operation of the other kind with any other outcome clears it: the steady state.
    await operation("pull", id, terminal("pull", 1, 3));
    expect(await connectorOf(id)).toMatchObject({
      signInNeeded: false,
      unknownOutcomes: [{ kind: "live-export", reason: "session-lost" }],
    });
  });

  it("AC1 an older session-lost under a newer success does not set sign-in-needed", async () => {
    const id = await connection("connector-sign-in-older");
    await operation("pull", id, terminal("pull", 1, 1, unknown("pull", "session-lost")));
    await operation("export", id, terminal("export", 1, 2));
    expect((await connectorOf(id))?.signInNeeded).toBe(false);
    const other = await connection("connector-sign-in-other-unknown");
    await operation("export", other, terminal("export", 1, 1, unknown("export", "session-lost")));
    await operation("export", other, terminal("export", 2, 2, unknown("export", "budget-exceeded")));
    expect(await connectorOf(other)).toMatchObject({
      signInNeeded: false,
      unknownOutcomes: [{ kind: "live-export", reason: "budget-exceeded", at: at(2) }],
    });
  });

  it("AC2 unknown rows follow each kind's newest terminal row, with suffix and reason", async () => {
    const id = await connection("connector-unknown-rows");
    const exportId = await operation("export", id, terminal("export", 1, 1, unknown("export", "download-unproven")));
    const pullId = await operation("pull", id, terminal("pull", 1, 2, unknown("pull", "completeness-unproven")));
    const runId = await batch(id, 1, "application-unknown", "connector", at(0), at(3));
    expect((await connectorOf(id))?.unknownOutcomes).toEqual([
      { kind: "live-export", idSuffix: exportId.slice(-4), reason: "download-unproven", at: at(1) },
      { kind: "order-pull", idSuffix: pullId.slice(-4), reason: "completeness-unproven", at: at(2) },
      { kind: "staged-import-batch", idSuffix: runId.slice(-4), reason: "application-unknown", at: at(3) },
    ]);
    // Only a newer terminal operation of the same kind clears its row.
    await operation("export", id, terminal("export", 2, 4));
    expect((await connectorOf(id))?.unknownOutcomes.map((row) => row.kind)).toEqual([
      "order-pull",
      "staged-import-batch",
    ]);
    await operation("pull", id, terminal("pull", 2, 5));
    await batch(id, 2, "composed", "connector", at(6));
    expect((await connectorOf(id))?.unknownOutcomes).toEqual([]);
  });

  it("AC2 Staged Import Batch rows read only connector-claimed batches, and manual runs keep their contribution", async () => {
    const id = await connection("connector-claimant");
    const runId = await batch(id, 1, "application-unknown", "connector", at(0), at(1));
    await batch(id, 2, "application-unknown", "manual", at(2), at(3));
    const attention = await read(id);
    expect(attention.connector?.unknownOutcomes).toEqual([
      { kind: "staged-import-batch", idSuffix: runId.slice(-4), reason: "application-unknown", at: at(1) },
    ]);
    expect(attention.manual).toMatchObject({ connectionId: id, reason: "unknown" });
    const manualOnly = await connection("connector-manual-only");
    await batch(manualOnly, 1, "application-unknown", "manual", at(0), at(1));
    expect(await read(manualOnly)).toMatchObject({ manual: { reason: "unknown" }, connector: null });
  });

  it("AC2 a connection with no connector work gets connector null", async () => {
    const id = await connection("connector-none");
    expect(await read(id)).toMatchObject({ connectionId: id, connector: null });
    expect(Object.hasOwn(await read(id), "connector")).toBe(true);
  });

  it("AC3 activity reports exact last success, complete queued count and in-flight start per kind", async () => {
    const id = await connection("connector-activity");
    await operation("export", id, terminal("export", 1, 1));
    await operation("export", id, terminal("export", 2, 2));
    await operation("export", id, terminal("export", 3, 3, unknown("export", "parse-refused")));
    await operation("export", id, { generation: 4, status: "in-flight", firstClaimedAt: at(4) });
    await operation("pull", id, terminal("pull", 1, 5));
    await operation("pull", id, { generation: 2, status: "pending" });
    await batch(id, 1, "applied", "connector", at(6), at(7));
    await batch(id, 2, "applied", "manual", at(8), at(9));
    await batch(id, 3, "claimed", "connector", at(10), at(11));
    expect((await connectorOf(id))?.activity).toEqual({
      "live-export": { lastSucceededAt: at(2), queued: 0, inFlightSince: at(4) },
      "order-pull": { lastSucceededAt: at(5), queued: 1, inFlightSince: null },
      "staged-import-batch": { lastSucceededAt: at(7), queued: 0, inFlightSince: at(10) },
    });
    const queuedBatch = await connection("connector-activity-queued-batch");
    await batch(queuedBatch, 1, "composed", "connector", at(12));
    expect((await connectorOf(queuedBatch))?.activity["staged-import-batch"]).toEqual({
      lastSucceededAt: null,
      queued: 1,
      inFlightSince: null,
    });
  });

  it("AC3 cap+1: counts stay complete across a 101-connection page in one batched read", async () => {
    // Producers allow one pending or in-flight row per connection and kind, so the capped surface is the page.
    const cap = 100;
    const owner = "acc_connector_cap_page";
    await h.db.query(
      `INSERT INTO channel_connections (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,projection_updated_at,last_stream_version)
      SELECT 'connector-cap-' || lpad(n::text,3,'0'),$1,'tcgplayer','sandbox','active','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',1
      FROM generate_series(1,$2::int) n`,
      [owner, cap + 1],
    );
    await h.db.query(
      `INSERT INTO channel_order_attention (account_id,connection_id,order_reference,reason,generation,affected_lines,opened_at)
      SELECT $1,'connector-cap-' || lpad(n::text,3,'0'),'synthetic-order','tcgplayer-order-unmapped',1,'[]','2026-10-01T00:00:00Z'
      FROM generate_series(1,$2::int) n`,
      [owner, cap + 1],
    );
    for (let n = 1; n <= cap + 1; n++) {
      const id = `connector-cap-${String(n).padStart(3, "0")}`;
      await operation("export", id, { generation: 1, status: "pending" });
      await operation("pull", id, { generation: 1, status: "pending" });
    }
    await expect(operation("export", "connector-cap-001", { generation: 2, status: "pending" })).rejects.toThrow(
      /channel_live_export_operations_one_live_uidx/,
    );
    let queries = 0;
    const counted = {
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        queries++;
        return h.db.query<Row>(sql, params);
      },
    };
    const page = await readConnectionAttention(counted, { accountId: owner });

    expect(page).toHaveLength(cap);
    expect(queries).toBe(6);
    const queued = page.reduce(
      (sum, row) =>
        sum +
        (row.connector?.activity["live-export"].queued ?? 0) +
        (row.connector?.activity["order-pull"].queued ?? 0),
      0,
    );
    const authoritative = await h.db.query<{ total: number }>(
      `SELECT (SELECT count(*) FROM channel_live_export_operations WHERE status='pending' AND connection_id=ANY($1::text[]))::int
        + (SELECT count(*) FROM channel_order_pull_operations WHERE status='pending' AND connection_id=ANY($1::text[]))::int AS total`,
      [page.map((row) => row.connectionId)],
    );
    expect(queued).toBe(2 * cap);
    expect(queued).toBe(authoritative.rows[0]!.total);
    expect(queued).toBeGreaterThan(cap + 1);
    const source = createChannelActionAttentionSourceFromReadModel(h.db);
    expect(await source.load({ accountId: owner, now: at(30) })).toHaveLength(cap);
  });

  it("AC5 the attention route returns the contribution only for the actor's own connection", async () => {
    const own = await connection("connector-route-own");
    await operation("export", own, terminal("export", 1, 1, unknown("export", "session-lost")));
    const foreign = await connection("connector-route-foreign", "acc_connector_foreign");
    const foreignId = await operation("export", foreign, terminal("export", 1, 1, unknown("export", "session-lost")));
    const app = new Hono<ChannelsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId, permissions: ["channels.view"] });
      c.set("context", context);
      await next();
    });
    app.route("/api/channels", buildChannelsApi(h.services));
    const ownResponse = await app.request(`http://local/api/channels/connections/${own}/attention`);
    expect(ownResponse.status).toBe(200);
    const body = await ownResponse.json();
    expect(body).toEqual(await read(own));
    expect(body.connector).toMatchObject({ signInNeeded: true, unknownOutcomes: [{ reason: "session-lost" }] });
    const foreignResponse = await app.request(`http://local/api/channels/connections/${foreign}/attention`);
    expect(foreignResponse.status).toBe(404);
    const refused = await foreignResponse.text();
    expect(JSON.parse(refused)).toEqual({ error: { code: "connection-not-found" } });
    expect(refused).not.toContain(foreignId.slice(-4));
  });
});
