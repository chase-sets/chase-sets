import catalogManifest from "@chase-sets/catalog/context";
import { expect, it } from "vitest";
import {
  createPostgresCatalogOperatorSessionStore,
  createTcgplayerAutomationRuntime,
} from "@chase-sets/catalog/server";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import {
  admin,
  adminPath,
  barrier,
  database,
  describeDb,
  keyring,
  mint,
  mounted,
  push,
  session,
  snapshot,
} from "../../../operator-session/fixture";

describeDb("real app and custody factory retained fence", () => {
  const db = database("operator_push");
  it("stored 1, cleared 2, new-grant stale 0, stored 3, replay stale and unchanged preserve the fence", async () => {
    const app = mounted(catalogManifest, db());
    const old = await mint(app);
    expect(await (await push(app, old)).json()).toEqual({ outcome: "stored", revision: 1 });
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "cleared", revision: 2 });
    expect(await (await admin(app, "GET", adminPath, {})).json()).toMatchObject({
      revision: 2,
      storedAt: null,
      browserExpiresAt: null,
      grant: { active: false },
    });
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "unchanged", revision: 2 });
    expect((await push(app, old, session(2))).status).toBe(401);
    const next = await mint(app);
    expect(await (await push(app, next)).json()).toEqual({ outcome: "stale-revision", revision: 2 });
    expect(await (await push(app, next, session(2))).json()).toEqual({ outcome: "stored", revision: 3 });
    expect(await (await push(app, next, session(2))).json()).toEqual({ outcome: "stale-revision", revision: 3 });
    const before = (await snapshot(db())).custody;
    expect(await (await push(app, next, session(3))).json()).toEqual({ outcome: "unchanged", revision: 3 });
    expect((await snapshot(db())).custody).toEqual(before);
    const runtime = createTcgplayerAutomationRuntime({ pool: db(), config: null, keyring });
    expect(await runtime?.store.resolve()).toEqual({ value: session().value, revision: 3 });
  });
  it.each(["clear", "accept"] as const)(
    "direct same-key delayed %s reaches resume and cannot damage HTTP replacement",
    async (operation) => {
      const app = mounted(catalogManifest, db());
      const old = await mint(app);
      await push(app, old);
      const gate = barrier();
      let paused = false;
      const observer: PgQueryable = {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
          const result = await db().query<Row>(sql, values);
          if (sql.startsWith("SELECT *") && !paused) {
            paused = true;
            await gate.pause();
          }
          return result;
        },
      };
      const delayedStore = createPostgresCatalogOperatorSessionStore(observer, keyring);
      const delayed =
        operation === "clear"
          ? delayedStore.clear({ expectedRevision: 1, expectedKeyId: keyring.activeKeyId })
          : delayedStore.accept(session(1, "obsolete"));
      await gate.arrival;
      await admin(app, "DELETE", adminPath);
      const next = await mint(app);
      const stale = await (await push(app, next)).json();
      await push(app, next, session(2, "replacement"));
      const before = (await snapshot(db())).custody;
      gate.resume();
      expect(await delayed, "resumed stale fence").toEqual({ outcome: "stale-revision", revision: 3 });
      expect((await snapshot(db())).custody, "resumed no-write assertion").toEqual(before);
      expect(stale).toEqual({ outcome: "stale-revision", revision: 2 });
    },
  );
  it("key-loss clear needs no decrypt and repeated cleared/absent DELETE is inert", async () => {
    const app = mounted(catalogManifest, db());
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "unchanged", revision: 0 });
    await push(app, await mint(app));
    const noKeys = mounted(catalogManifest, db(), { keys: null });
    expect(await (await admin(noKeys, "GET", adminPath, {})).json()).toMatchObject({
      custodyAvailable: false,
      revision: 1,
    });
    expect(await (await admin(noKeys, "DELETE", adminPath)).json()).toEqual({ outcome: "cleared", revision: 2 });
    const before = await snapshot(db());
    expect(await (await admin(noKeys, "DELETE", adminPath)).json()).toEqual({ outcome: "unchanged", revision: 2 });
    expect(await snapshot(db())).toEqual(before);
    const runtime = createTcgplayerAutomationRuntime({
      pool: db(),
      keyring: null,
      config: { auth: { tcgAuthCookie: "synthetic-environment", userAgent: "synthetic" } },
    });
    expect(await runtime?.catalogClient.resolveCredentialReadiness()).toEqual({
      sourceKind: "environment-secret",
      state: "configured",
      diagnosticCode: null,
    });
    // The landed precedence suite verifies the actual provider attempt carries environment revision 0.
  });
});
