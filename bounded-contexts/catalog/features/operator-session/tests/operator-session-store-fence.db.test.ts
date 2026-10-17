import { expect, it } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { createPostgresCatalogOperatorSessionStore } from "../api/store";
import { describeDb, keyring, session, useOperatorSessionDatabase } from "./db-fixture";

function pausedRead(db: PgQueryable, parties = 1) {
  let signalReached!: () => void;
  let signalRelease!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  let arrivals = 0;
  const proxy: PgQueryable = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      const result = await db.query<Row>(sql, values);
      if (sql.startsWith("SELECT *") && arrivals < parties) {
        if (++arrivals === parties) signalReached();
        await release;
      }
      return result;
    },
  };
  return { proxy, reached, resume: signalRelease };
}

describeDb("operator-session retained fence (B8450-01, PT8450R1-01..06)", () => {
  const db = useOperatorSessionDatabase("operator_session_fence");
  const store = (pool: PgQueryable = db(), keys = keyring) => createPostgresCatalogOperatorSessionStore(pool, keys);

  it.each(["clear", "accept"] as const)(
    "PT01: delayed %s cannot mutate the same-key reaccepted row",
    async (operation) => {
      const authority = store();
      expect(await authority.accept(session(0))).toEqual({ outcome: "stored", revision: 1 });
      const barrier = pausedRead(db());
      const delayed =
        operation === "clear"
          ? store(barrier.proxy).clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })
          : store(barrier.proxy).accept(session(1, "delayed-obsolete-value"));
      await barrier.reached;
      const cleared = await authority.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId });
      let recreated = await authority.accept(session(0, "new-credential"));
      const initialRecreate = recreated;
      if (recreated.outcome === "stale-revision")
        recreated = await authority.accept(session(recreated.revision, "new-credential"));
      const before = await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions");
      barrier.resume();
      expect(await delayed, "resume: delayed mutation must be stale").toEqual({
        outcome: "stale-revision",
        revision: recreated.revision,
      });
      expect(
        await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions"),
        "resume: zero writes",
      ).toEqual(before);
      expect(await authority.resolve()).toEqual({ value: "new-credential", revision: 3 });
      expect([cleared, initialRecreate, recreated]).toEqual([
        { outcome: "cleared", revision: 2 },
        { outcome: "stale-revision", revision: 2 },
        { outcome: "stored", revision: 3 },
      ]);
    },
  );

  it.each(["delete-restart", "cleared-as-absent"] as const)(
    "PT01 red control: %s reaches resume then violates both delayed fences",
    async (mutant) => {
      for (const operation of ["clear", "accept"] as const) {
        await db().query("TRUNCATE catalog_tcgplayer_operator_sessions");
        const mutated: PgQueryable = {
          async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
            if (mutant === "delete-restart" && sql.includes("SET state = 'cleared'")) {
              return db().query<Row>(
                "DELETE FROM catalog_tcgplayer_operator_sessions WHERE provider_key = $1 AND revision = $2 AND key_id = $3 RETURNING revision",
                values?.slice(0, 3),
              );
            }
            if (mutant === "cleared-as-absent" && sql.startsWith("SELECT *")) {
              const result = await db().query<Row>(sql + " AND state = 'stored'", values);
              return result;
            }
            if (mutant === "cleared-as-absent" && sql.startsWith("INSERT")) {
              sql = sql.replace(
                "DO NOTHING",
                "DO UPDATE SET state = EXCLUDED.state, revision = EXCLUDED.revision, key_id = EXCLUDED.key_id, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, stored_at = EXCLUDED.stored_at, observed_at = EXCLUDED.observed_at, browser_expires_at = EXCLUDED.browser_expires_at",
              );
            }
            return db().query<Row>(sql, values);
          },
        };
        const authority = store(mutated);
        await authority.accept(session(0));
        const barrier = pausedRead(mutated);
        const delayed =
          operation === "clear"
            ? store(barrier.proxy).clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })
            : store(barrier.proxy).accept(session(1, "obsolete"));
        await barrier.reached;
        await authority.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId });
        let recreated = await authority.accept(session(0, "replacement"));
        if (recreated.outcome === "stale-revision")
          recreated = await authority.accept(session(recreated.revision, "replacement"));
        const before = await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions");
        barrier.resume();
        const result = await delayed;
        expect(() =>
          expect(result, "resume stale assertion").toEqual({ outcome: "stale-revision", revision: recreated.revision }),
        ).toThrow();
        expect(
          await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions"),
        ).not.toEqual(before);
      }
    },
  );

  it("PT02/04: clear erases every credential field, retains metadata, and is inert when repeated", async () => {
    const authority = store();
    expect(await authority.clear({ expectedRevision: 0, expectedKeyId: null })).toEqual({
      outcome: "unchanged",
      revision: 0,
    });
    expect(await authority.readMetadata()).toBeNull();
    await authority.accept(session(0));
    expect(await authority.readMetadata()).toMatchObject({
      state: "stored",
      revision: 1,
      keyId: keyring.activeKeyId,
      observedAt: session(0).observedAt,
      browserExpiresAt: null,
    });
    expect(await authority.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })).toEqual({
      outcome: "cleared",
      revision: 2,
    });
    const before = await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions");
    expect(before.rows[0]).toMatchObject({
      provider_key: "tcgplayer",
      version: "CatalogOperatorSession/v1",
      revision: "2",
      key_id: keyring.activeKeyId,
      ciphertext: null,
      iv: null,
      tag: null,
      stored_at: null,
      observed_at: null,
      browser_expires_at: null,
    });
    expect(await authority.readMetadata()).toEqual({ state: "cleared", revision: 2, keyId: keyring.activeKeyId });
    expect(await authority.resolve()).toBeNull();
    expect(await authority.clear({ expectedRevision: 2, expectedKeyId: keyring.activeKeyId })).toEqual({
      outcome: "unchanged",
      revision: 2,
    });
    expect(await authority.accept(session(0))).toEqual({ outcome: "stale-revision", revision: 2 });
    expect(await authority.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })).toEqual({
      outcome: "stale-revision",
      revision: 2,
    });
    expect(await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions")).toEqual(
      before,
    );
  });

  it("PT02: bounded overflow refuses both writes; stale fences and invalid key fences do not write", async () => {
    const authority = store();
    await authority.accept(session(0));
    await db().query("UPDATE catalog_tcgplayer_operator_sessions SET revision = 9007199254740991");
    const before = await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions");
    await expect(authority.accept(session(Number.MAX_SAFE_INTEGER, "new"))).rejects.toMatchObject({
      code: "revision-exhausted",
    });
    await expect(
      authority.clear({ expectedRevision: Number.MAX_SAFE_INTEGER, expectedKeyId: keyring.activeKeyId }),
    ).rejects.toMatchObject({ code: "revision-exhausted" });
    await expect(authority.clear({ expectedRevision: 1, expectedKeyId: null })).rejects.toMatchObject({
      code: "invalid-session-fence",
    });
    expect(await authority.clear({ expectedRevision: 1, expectedKeyId: "wrong-key" })).toEqual({
      outcome: "stale-revision",
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions")).toEqual(
      before,
    );
  });

  it("identical active-key acceptance is inert; key-only rotation advances and re-seals", async () => {
    const authority = store();
    await authority.accept(session(0));
    const before = await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions");
    expect(await authority.accept(session(1))).toEqual({ outcome: "unchanged", revision: 1 });
    expect(await db().query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions")).toEqual(
      before,
    );
    const rotated = store(db(), {
      activeKeyId: "rotated",
      keys: new Map([...keyring.keys, ["rotated", new Uint8Array(32).fill(8)]]),
    });
    expect(await rotated.accept(session(1))).toEqual({ outcome: "stored", revision: 2 });
    expect(await rotated.resolve()).toEqual({ value: session(1).value, revision: 2 });
    expect(await rotated.readMetadata()).toMatchObject({ keyId: "rotated" });
  });

  it("PT05: unreadable custody can only be replaced or cleared by the matching fence without decrypt", async () => {
    await store().accept(session(0));
    const lost = createPostgresCatalogOperatorSessionStore(db(), null);
    expect(await lost.resolve()).toEqual({ unavailable: "custody" });
    expect(await lost.clear({ expectedRevision: 0, expectedKeyId: null })).toEqual({
      outcome: "stale-revision",
      revision: 1,
    });
    expect(await lost.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })).toEqual({
      outcome: "cleared",
      revision: 2,
    });
    expect(await lost.resolve()).toBeNull();
    await store().accept(session(2));
    await db().query("UPDATE catalog_tcgplayer_operator_sessions SET tag = decode(repeat('00',16),'hex')");
    expect(await store().resolve()).toEqual({ unavailable: "custody" });
    expect(await store().accept(session(3, "repaired"))).toEqual({ outcome: "stored", revision: 4 });
  });

  it("PT04 red control: a state-only clear is rejected rather than retaining credential bytes", async () => {
    await store().accept(session(0));
    const codes: unknown[] = [];
    const mutated: PgQueryable = {
      async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
        if (sql.includes("SET state = 'cleared'")) {
          sql = sql.replace(
            ",\n          ciphertext = NULL, iv = NULL, tag = NULL, stored_at = NULL, observed_at = NULL, browser_expires_at = NULL",
            "",
          );
        }
        try {
          return await db().query<Row>(sql, values);
        } catch (error) {
          codes.push(
            typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "code")?.value : null,
          );
          throw error;
        }
      },
    };
    await expect(
      store(mutated).clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId }),
    ).rejects.toMatchObject({ code: "custody-unavailable" });
    expect(codes).toEqual(["23514"]);
    expect(await store().readMetadata()).toMatchObject({ state: "stored", revision: 1 });
  });

  it("PT06 red control: removing conflict handling makes the first-insert loser throw", async () => {
    const codes: unknown[] = [];
    const mutated: PgQueryable = {
      async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
        try {
          return await db().query<Row>(sql.replace("ON CONFLICT (provider_key) DO NOTHING", ""), values);
        } catch (error) {
          codes.push(
            typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "code")?.value : null,
          );
          throw error;
        }
      },
    };
    const barrier = pausedRead(mutated, 2);
    const results = Promise.allSettled([
      store(barrier.proxy).accept(session(0, "first")),
      store(barrier.proxy).accept(session(0, "second")),
    ]);
    await barrier.reached;
    barrier.resume();
    const outcomes = await results;
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(codes).toEqual(["23505"]);
  });

  it.each([0, 1])("PT06: concurrent accepts at revision %i have one winner without throwing", async (revision) => {
    if (revision) await store().accept(session(0));
    const barrier = pausedRead(db(), 2);
    const first = store(barrier.proxy).accept(session(revision, "first"));
    const second = store(barrier.proxy).accept(session(revision, "second"));
    await barrier.reached;
    barrier.resume();
    expect((await Promise.all([first, second])).sort((a, b) => a.outcome.localeCompare(b.outcome))).toEqual([
      { outcome: "stale-revision", revision: revision + 1 },
      { outcome: "stored", revision: revision + 1 },
    ]);
    expect((await db().query("SELECT count(*)::int AS count FROM catalog_tcgplayer_operator_sessions")).rows).toEqual([
      { count: 1 },
    ]);
  });

  it.each([
    "state = 'unknown'",
    "revision = 0",
    "revision = 9007199254740992",
    "version = 'v2'",
    "provider_key = 'other'",
    "key_id = 'bad key'",
    "key_id = ''",
    "key_id = repeat('a',65)",
    "ciphertext = NULL",
    "ciphertext = decode('','hex')",
    "ciphertext = decode(repeat('01',4097),'hex')",
    "iv = NULL",
    "tag = NULL",
    "stored_at = NULL",
    "observed_at = NULL",
    "iv = decode('00','hex')",
    "tag = decode('00','hex')",
    "stored_at = 'infinity'",
    "observed_at = 'infinity'",
    "browser_expires_at = 'infinity'",
    "state = 'cleared'",
  ])("PT04: closed stored shape rejects %s", async (assignment) => {
    await store().accept(session(0));
    await expect(db().query(`UPDATE catalog_tcgplayer_operator_sessions SET ${assignment}`)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it.each([
    "ciphertext = decode('01','hex')",
    "iv = decode(repeat('00',12),'hex')",
    "tag = decode(repeat('00',16),'hex')",
    "stored_at = now()",
    "observed_at = now()",
    "browser_expires_at = now()",
  ])("PT04: cleared shape rejects %s", async (assignment) => {
    const authority = store();
    await authority.accept(session(0));
    await authority.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId });
    await expect(db().query(`UPDATE catalog_tcgplayer_operator_sessions SET ${assignment}`)).rejects.toMatchObject({
      code: "23514",
    });
  });
});
