import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { OperatorAuthorityDecision } from "@chase-sets/auth-context";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { upsertProviderScopeObservations } from "../../provider-scope-discovery/api/refresh-schedule-store";
import { operatorSessionPublicRoutes } from "../api/route";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import {
  grantBearer,
  provenance,
  routePath,
  salvage,
  setNameEntry,
  setNamePost,
  unicodeControlSets,
} from "./set-name-observation-fixture";

const granted: OperatorAuthorityDecision = {
  kind: "granted",
  membershipId: provenance.creatorMembershipId,
  roleKey: "platform-admin",
  rolePermissions: ["catalog.manage"],
};
const pokemonUnitKey = "tcgplayer:pokemon:single-card:source-observation-import";
const magicUnit = salvage.units.find((unit) => unit.productLineId === 1)!;

type ObservationRow = Readonly<{
  provider_key: string;
  unit_key: string;
  scope_kind: string;
  source_query_kind: string;
  language_code: string;
  external_id: string;
  label: string;
  parents: string[];
  image_url: string | null;
  metadata: Record<string, unknown>;
}>;

describeDb("operator-extension set-name observation posts against the catalog store", () => {
  const db = useOperatorSessionDatabase("set_name_observation_post");

  async function compose(beforeQuery: (sql: string) => void = () => {}) {
    const base = db();
    const pool: PgTransactionalPool = {
      query: base.query.bind(base),
      idleInTransactionSessionTimeoutMillis: base.idleInTransactionSessionTimeoutMillis,
      async connect() {
        const client = await base.connect();
        return {
          async query<Row>(sql: string, params?: readonly unknown[]) {
            beforeQuery(sql);
            return client.query<Row>(sql, params);
          },
          release: client.release.bind(client),
        };
      },
    };
    await pool.query(
      `INSERT INTO catalog_operator_session_grants
         (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days')`,
      [
        provenance.grantId,
        createHash("sha256").update(grantBearer, "ascii").digest(),
        provenance.creatorUserId,
        provenance.creatorMembershipId,
      ],
    );
    const services = catalogModule.createServices(pool, {
      catalogOperatorAuthority: { forActor: async () => granted, forGrantCreator: async () => granted },
    });
    const app = operatorSessionPublicRoutes(services.operatorSession);
    const post = (body: unknown, bearer = grantBearer) =>
      app.request(routePath, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { pool, post };
  }

  async function observationRows(pool: PgQueryable, unitKey: string) {
    const result = await pool.query<ObservationRow>(
      `SELECT provider_key, unit_key, scope_kind, source_query_kind, language_code, external_id, label,
              parents, image_url, metadata
         FROM catalog_provider_scope_observations
        WHERE unit_key = $1`,
      [unitKey],
    );
    return result.rows
      .map((row) => ({
        providerKey: row.provider_key,
        unitKey: row.unit_key,
        scopeKind: row.scope_kind,
        sourceQueryKind: row.source_query_kind,
        languageCode: row.language_code,
        externalId: row.external_id,
        label: row.label,
        parents: row.parents,
        imageUrl: row.image_url,
        metadata: row.metadata,
      }))
      .sort(byExternalId);
  }

  async function mappingEventCount(pool: PgQueryable) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'`,
    );
    return Number(result.rows[0]!.count);
  }

  async function seedMagicScope(pool: PgQueryable) {
    await pool.query(
      `INSERT INTO catalog_scope_records (
         scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id,
         reference_record_key, name, lifecycle_status
       ) VALUES ('scope-synthetic-magic-core', 'magic', 'set', 'set', 'scope-synthetic-magic-core',
                 'scope-synthetic-magic-core', 'Synthetic Magic Core Set', 'active')`,
    );
  }

  it("records Magic and One Piece posts equal to the removed collectTargetOptions observations plus provenance", async () => {
    const { pool, post } = await compose();
    for (const unit of salvage.units) {
      const response = await post(setNamePost(unit.productLineId, unit.sets));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      // No canonical scope records exist, so each observation proposes a new canonical scope.
      expect(await response.json()).toEqual({
        observationCount: unit.observations.length,
        newObservationCount: unit.observations.length,
        mappingsProposed: unit.observations.length,
      });
      expect(await observationRows(pool, unit.unitKey)).toEqual(
        unit.observations
          .map((observation) => ({ ...observation, metadata: { ...observation.metadata, ...provenance } }))
          .sort(byExternalId),
      );
    }
    const schedule = await pool.query<{ last_run_status: string; last_run_triggered_by: string; last_run_error: null }>(
      `SELECT last_run_status, last_run_triggered_by, last_run_error
         FROM catalog_provider_refresh_schedule WHERE provider_key = 'tcgplayer'`,
    );
    expect(schedule.rows).toEqual([
      {
        last_run_status: "succeeded",
        last_run_triggered_by: `operator-extension-grant:${provenance.grantId}`,
        last_run_error: null,
      },
    ]);
  });

  it("stores every synthetic Pokemon Unicode and releaseDate control with provider text unchanged", async () => {
    const { pool, post } = await compose();
    expect((await post(setNamePost(3, unicodeControlSets))).status).toBe(200);
    const rows = await observationRows(pool, pokemonUnitKey);
    expect(rows).toHaveLength(unicodeControlSets.length);
    for (const set of unicodeControlSets) {
      const row = rows.find((stored) => stored.metadata.setNameId === String(set.setNameId));
      expect(row, `setNameId ${set.setNameId}`).toMatchObject({
        scopeKind: "expansion",
        externalId: set.cleanSetName,
        label: set.name,
        parents: ["3"],
        metadata: {
          cleanSetName: set.cleanSetName,
          urlName: set.urlName,
          abbreviation: set.abbreviation,
          releaseDate: set.releaseDate,
        },
      });
    }
  });

  it("keeps a leading-FEFF id distinct from its plain twin with an equal display name", async () => {
    const { pool, post } = await compose();
    expect((await post(setNamePost(3, unicodeControlSets))).status).toBe(200);
    const twins = (await observationRows(pool, pokemonUnitKey)).filter((row) => row.label === "Synthetic Base");
    expect(twins.map((row) => row.externalId).sort()).toEqual(["Synthetic Base", "﻿Synthetic Base"]);
    expect(twins.map((row) => row.metadata.setNameId).sort()).toEqual(["920005", "920006"]);
  });

  it("converges concurrent first posts and identical repeats without duplicate rows or mapping proposals", async () => {
    const { pool, post } = await compose();
    await seedMagicScope(pool);
    const magic = setNamePost(1, magicUnit.sets);
    const pokemon = setNamePost(3, unicodeControlSets);
    const count = magicUnit.observations.length;

    const racing = await Promise.all([post(magic), post(magic)]);
    expect(racing.map((response) => response.status)).toEqual([200, 200]);
    const raced = (await Promise.all(racing.map((response) => response.json()))) as {
      newObservationCount: number;
      mappingsProposed: number;
    }[];
    expect(raced.map((result) => result.newObservationCount).sort()).toEqual([0, count]);
    expect(raced.map((result) => result.mappingsProposed).sort()).toEqual([0, count]);
    expect(await mappingEventCount(pool)).toBe(count);

    const accepted = await pool.query<{ review_status: string; actor: string }>(
      `SELECT payload->>'reviewStatus' AS review_status, payload->>'actor' AS actor
         FROM event_store_events
        WHERE stream_id LIKE 'catalog.provider-scope-mapping-%' AND payload->>'scopeRecordId' = 'scope-synthetic-magic-core'`,
    );
    expect(accepted.rows).toEqual([
      { review_status: "auto-accepted", actor: `operator-extension-grant:${provenance.grantId}` },
    ]);

    expect((await post(pokemon)).status).toBe(200);
    const events = await mappingEventCount(pool);
    expect(await (await post(magic)).json()).toEqual({
      observationCount: count,
      newObservationCount: 0,
      mappingsProposed: 0,
    });

    const repeated = await Promise.all([post(magic), post(pokemon), post(magic)]);
    expect(repeated.map((response) => response.status)).toEqual([200, 200, 200]);
    for (const response of repeated)
      expect(await response.json()).toMatchObject({ newObservationCount: 0, mappingsProposed: 0 });
    expect(await mappingEventCount(pool)).toBe(events);
    expect(await observationRows(pool, magicUnit.unitKey)).toHaveLength(count);
    expect(await observationRows(pool, pokemonUnitKey)).toHaveLength(unicodeControlSets.length);
  });

  it.each(["matching", "second proposal"])(
    "rolls back failed %s writes and completes identical retries",
    async (failure) => {
      let fail = true;
      let appends = 0;
      const statements: string[] = [];
      const { pool, post } = await compose((sql) => {
        statements.push(sql);
        if (fail && failure === "matching" && sql.includes("FROM catalog_scope_records"))
          throw new Error("synthetic transient matcher failure");
        if (fail && failure === "second proposal" && /INSERT INTO .*event_store_events/.test(sql) && ++appends === 2)
          throw new Error("synthetic transient command failure");
      });
      const body = setNamePost(3, [setNameEntry(3, 940001), setNameEntry(3, 940002)]);
      const first = await post(body);
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({
        code: "scope-observations-unavailable",
      });
      expect(await observationRows(pool, pokemonUnitKey)).toEqual([]);
      expect((await pool.query("SELECT proposal_id FROM catalog_scope_record_proposals")).rows).toEqual([]);
      expect(await mappingEventCount(pool)).toBe(failure === "matching" ? 0 : 1);
      expect(statements).toContain("ROLLBACK");
      expect(
        (
          await pool.query(
            "SELECT last_run_status, last_run_error FROM catalog_provider_refresh_schedule WHERE provider_key = 'tcgplayer'",
          )
        ).rows,
      ).toEqual([{ last_run_status: "failed", last_run_error: "scope-observations-unavailable" }]);
      fail = false;
      const retry = await post(body);
      expect(retry.status).toBe(200);
      expect(await observationRows(pool, pokemonUnitKey)).toHaveLength(2);
      expect((await pool.query("SELECT proposal_id FROM catalog_scope_record_proposals")).rows).toHaveLength(2);
      const streams = await pool.query<{ count: string }>(
        "SELECT count(DISTINCT stream_id)::text AS count FROM event_store_events WHERE stream_id LIKE 'catalog.provider-scope-mapping-%'",
      );
      expect(streams.rows).toEqual([{ count: "2" }]);
      const events = await mappingEventCount(pool);
      const third = await post(body);
      expect(third.status).toBe(200);
      expect(await third.json()).toEqual({ observationCount: 2, newObservationCount: 0, mappingsProposed: 0 });
      expect(await mappingEventCount(pool)).toBe(events);
    },
  );

  it("writes extension provider text raw while existing producers keep default normalization", async () => {
    const { pool, post } = await compose();
    const padded = setNameEntry(3, 930001, { name: " Synthetic Padded ", cleanSetName: "﻿ Synthetic Padded " });
    expect((await post(setNamePost(3, [padded]))).status).toBe(200);
    await upsertProviderScopeObservations(pool, {
      scanId: "job_default_producer",
      scannedAt: new Date(),
      observations: [
        {
          providerKey: " TCGDEX ",
          unitKey: "tcgdex:pokemon:single-card:source-observation-import",
          scopeKind: "expansion",
          sourceQueryKind: "expansions",
          languageCode: "EN",
          externalId: "﻿ sv-padded ",
          label: " Padded Expansion ",
          parents: [" sv "],
          imageUrl: null,
          metadata: {},
        },
      ],
    });

    expect((await observationRows(pool, pokemonUnitKey)).map((row) => [row.externalId, row.label])).toEqual([
      ["﻿ Synthetic Padded ", " Synthetic Padded "],
    ]);
    expect(
      (await observationRows(pool, "tcgdex:pokemon:single-card:source-observation-import")).map((row) => [
        row.providerKey,
        row.externalId,
        row.label,
        row.parents,
      ]),
    ).toEqual([["tcgdex", "sv-padded", "Padded Expansion", ["sv"]]]);
  });

  it("refuses an unknown grant without reading the body or writing observations, runs, events or grant use", async () => {
    const { pool, post } = await compose();
    const counts = () =>
      pool.query<{ observations: string; proposals: string; runs: string; events: string }>(
        `SELECT (SELECT count(*) FROM catalog_provider_scope_observations)::text AS observations,
                (SELECT count(*) FROM catalog_scope_record_proposals)::text AS proposals,
                (SELECT count(*) FROM catalog_provider_refresh_schedule WHERE last_run_status IS NOT NULL)::text AS runs,
                (SELECT count(*) FROM event_store_events)::text AS events`,
      );
    const before = await counts();
    const grantBefore = await pool.query("SELECT last_used_at, idle_expires_at FROM catalog_operator_session_grants");
    const response = await post(setNamePost(1, magicUnit.sets), "U".repeat(43));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"code":"grant-invalid"}');
    expect(before.rows).toEqual([{ observations: "0", proposals: "0", runs: "0", events: expect.any(String) }]);
    expect((await counts()).rows).toEqual(before.rows);
    expect(
      (await pool.query("SELECT last_used_at, idle_expires_at FROM catalog_operator_session_grants")).rows,
    ).toEqual(grantBefore.rows);
  });

  it("keeps the bearer out of observation rows, run records and events", async () => {
    const { pool, post } = await compose();
    await seedMagicScope(pool);
    expect((await post(setNamePost(1, magicUnit.sets))).status).toBe(200);
    const dump = await pool.query<{ text: string }>(
      `SELECT concat_ws(' ',
         (SELECT string_agg(row_to_json(o)::text, ' ') FROM catalog_provider_scope_observations o),
         (SELECT string_agg(row_to_json(s)::text, ' ') FROM catalog_provider_refresh_schedule s),
         (SELECT string_agg(row_to_json(e)::text, ' ') FROM event_store_events e)) AS text`,
    );
    expect(dump.rows[0]!.text).toContain(provenance.grantId);
    expect(dump.rows[0]!.text).not.toContain(grantBearer);
    expect(dump.rows[0]!.text).not.toContain(createHash("sha256").update(grantBearer, "ascii").digest("hex"));
  });
});

function byExternalId(left: { externalId: string }, right: { externalId: string }) {
  return left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0;
}
