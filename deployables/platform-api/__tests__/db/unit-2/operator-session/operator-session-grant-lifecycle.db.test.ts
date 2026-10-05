import catalogManifest from "@chase-sets/catalog/context";
import { expect, it } from "vitest";
import { createPostgresCatalogOperatorSessionStore } from "@chase-sets/catalog/server";
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
  transport,
  unpair,
} from "../../../operator-session/fixture";

describeDb("atomic acknowledged PUT and irreversible revoke", () => {
  const db = database("operator_grant_lifecycle");
  it("Disconnect returns a stale clear without retry and keeps its acknowledged revoke", async () => {
    const wire = transport(db());
    const app = mounted(catalogManifest, wire.pool);
    const grant = await mint(app);
    await push(app, grant);
    const metadata = barrier();
    let paused = false;
    wire.controls.after = async (sql) => {
      if (!paused && sql.startsWith("SELECT * FROM catalog_tcgplayer_operator_sessions")) {
        paused = true;
        await metadata.pause();
      }
    };
    const pending = admin(app, "DELETE", adminPath);
    await metadata.arrival;
    expect((await snapshot(db())).grants[0]!.revoke_reason).toBe("disconnect");
    const direct = createPostgresCatalogOperatorSessionStore(db(), keyring);
    expect(await direct.accept(session(1, "synthetic-competing-custody"))).toEqual({ outcome: "stored", revision: 2 });
    const before = await snapshot(db());
    metadata.resume();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "stale-revision", revision: 2 });
    expect(await snapshot(db())).toEqual(before);
    expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({ outcome: "cleared", revision: 3 });
  });
  it.each(["stored", "unchanged", "stale-revision"] as const)(
    "%s renews exactly from DB time only after COMMIT acknowledgement",
    async (outcome) => {
      const wire = transport(db());
      wire.controls.now = new Date("2026-12-01T00:00:00.000Z");
      const app = mounted(catalogManifest, wire.pool);
      const grant = await mint(app);
      if (outcome !== "stored") await push(app, grant);
      const before = await snapshot(db());
      wire.controls.now = new Date("2026-12-02T03:04:05.006Z");
      const commit = barrier();
      wire.controls.before = async (sql) => {
        if (sql === "COMMIT") await commit.pause();
      };
      let completed = false;
      const pending = push(app, grant, session(outcome === "unchanged" ? 1 : 0)).then((response) => {
        completed = true;
        return response;
      });
      await commit.arrival;
      expect(completed).toBe(false);
      expect(await snapshot(db()), "observer before commit").toEqual(before);
      commit.resume();
      const response = await pending;
      expect(response.status).toBe(outcome === "stale-revision" ? 409 : 200);
      expect(await response.json()).toEqual({ outcome, revision: 1 });
      const after = await snapshot(db());
      expect(after.grants[0]).toMatchObject({
        created_at: before.grants[0]!.created_at,
        last_used_at: wire.controls.now,
        idle_expires_at: new Date("2027-01-01T03:04:05.006Z"),
      });
      if (outcome !== "stored") expect(after.custody).toEqual(before.custody);
      expect(wire.live).toBe(0);
    },
  );
  it.each(["unpair", "disconnect", "replace"] as const)(
    "two apps serialize %s through a paused custody write",
    async (action) => {
      const wire = transport(db());
      const app = mounted(catalogManifest, wire.pool);
      const other = mounted(catalogManifest, db());
      const old = await mint(app);
      const accept = barrier();
      wire.controls.after = async (sql) => {
        if (sql.startsWith("INSERT INTO catalog_tcgplayer_operator_sessions")) await accept.pause();
      };
      const pending = push(app, old);
      await accept.arrival;
      let revoked = false;
      const revocation = (
        action === "unpair"
          ? unpair(other, old)
          : action === "disconnect"
            ? admin(other, "DELETE", adminPath)
            : admin(other)
      ).then((response) => {
        revoked = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(revoked).toBe(false);
      accept.resume();
      expect((await pending).status).toBe(200);
      expect((await revocation).status).toBe(200);
      const after = await snapshot(db());
      expect((await push(app, old, session(1, "obsolete"))).status).toBe(401);
      expect(await snapshot(db())).toEqual(after);
      expect(after.custody[0]!.state).toBe(action === "disconnect" ? "cleared" : "stored");
    },
  );
  it("kills the SAME paused accept backend before another app revokes; no late write or leaked slot", async () => {
    const wire = transport(db());
    const app = mounted(catalogManifest, wire.pool);
    const other = mounted(catalogManifest, db());
    const grant = await mint(app);
    const before = await snapshot(db());
    const accept = barrier();
    let pid = 0;
    wire.controls.after = async (sql, _values, client) => {
      if (sql.startsWith("INSERT INTO catalog_tcgplayer_operator_sessions")) {
        pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await accept.pause();
      }
    };
    const pending = push(app, grant);
    await accept.arrival;
    expect(
      (await db().query<{ killed: boolean }>("SELECT pg_terminate_backend($1) AS killed", [pid])).rows[0]!.killed,
    ).toBe(true);
    expect((await unpair(other, grant)).status).toBe(200);
    accept.resume();
    expect((await pending).status).toBe(503);
    const after = await snapshot(db());
    expect(after.custody).toEqual(before.custody);
    expect(after.grants[0]).toMatchObject({ last_used_at: before.grants[0]!.last_used_at, revoke_reason: "unpair" });
    expect(wire.destroyed).toBe(1);
    expect(wire.live).toBe(0);
    wire.controls.after = undefined;
    for (let i = 0; i < 5; i++) expect((await admin(app, "GET", adminPath, {})).status).toBe(200);
    expect((await push(app, grant)).status).toBe(401);
    expect(
      wire.statements.filter((sql) => sql.startsWith("INSERT INTO catalog_tcgplayer_operator_sessions")),
    ).toHaveLength(1);
  });
  it.each(["stored", "unchanged", "stale-revision"] as const)(
    "lost COMMIT acknowledgement discriminates both durable outcomes for %s",
    async (outcome) => {
      for (const committed of [false, true]) {
        await db().query("TRUNCATE catalog_operator_session_grants, catalog_tcgplayer_operator_sessions");
        const wire = transport(db());
        wire.controls.now = new Date("2026-12-01T00:00:00.000Z");
        const app = mounted(catalogManifest, wire.pool);
        const grant = await mint(app);
        if (outcome !== "stored") await push(app, grant);
        const before = await snapshot(db());
        wire.controls.now = new Date("2026-12-02T00:00:00.000Z");
        const commitsBefore = wire.statements.filter((sql) => sql === "COMMIT").length;
        if (committed) {
          wire.controls.after = async (sql) => {
            if (sql === "COMMIT") throw new Error("synthetic-ack-dropped-after-real-commit");
          };
        } else {
          wire.controls.before = async (sql, _values, client) => {
            if (sql === "COMMIT") {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
              await db().query("SELECT pg_terminate_backend($1)", [pid]);
            }
          };
        }
        const response = await push(app, grant, session(outcome === "unchanged" ? 1 : 0));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "custody-unavailable" });
        expect(wire.statements.filter((sql) => sql === "COMMIT")).toHaveLength(commitsBefore + 1);
        expect(wire.destroyed).toBe(1);
        expect(wire.live).toBe(0);
        const after = await snapshot(db());
        if (!committed) expect(after).toEqual(before);
        else {
          expect(after.grants[0]).toMatchObject({
            last_used_at: wire.controls.now,
            idle_expires_at: new Date("2027-01-01T00:00:00.000Z"),
          });
          if (outcome === "stored") expect(after.custody[0]).toMatchObject({ revision: "1", state: "stored" });
          else expect(after.custody).toEqual(before.custody);
        }
        wire.controls.before = undefined;
        wire.controls.after = undefined;
        const retry = await push(app, grant, session(outcome === "unchanged" ? 1 : 0));
        expect(await retry.json()).toEqual({
          outcome: outcome === "stored" ? (committed ? "stale-revision" : "stored") : outcome,
          revision: 1,
        });
        expect(await (await push(app, grant, session(1))).json()).toEqual({ outcome: "unchanged", revision: 1 });
      }
    },
  );
  it.each(["metadata", "clear", "revoke-ack", "clear-ack"] as const)(
    "Disconnect %s failure preserves its asymmetric commit contract",
    async (failure) => {
      const wire = transport(db());
      const app = mounted(catalogManifest, wire.pool);
      const grant = await mint(app);
      await push(app, grant);
      const before = await snapshot(db());
      let commits = 0;
      let reads = 0;
      wire.controls.before = async (sql) => {
        if (sql.startsWith("SELECT * FROM catalog_tcgplayer_operator_sessions")) {
          reads++;
          if (failure === "metadata") throw new Error("synthetic-metadata-failure");
        }
        if (failure === "clear" && sql.includes("SET state = 'cleared'")) throw new Error("synthetic-clear-failure");
      };
      wire.controls.after = async (sql) => {
        if (sql !== "COMMIT") return;
        commits++;
        if ((failure === "revoke-ack" && commits === 1) || (failure === "clear-ack" && commits === 2))
          throw new Error("synthetic-ack-loss");
      };
      const response = await admin(app, "DELETE", adminPath);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "custody-unavailable" });
      const after = await snapshot(db());
      expect(after.grants[0]!.revoke_reason).toBe("disconnect");
      expect(after.grants[0]!.last_used_at).toEqual(before.grants[0]!.last_used_at);
      if (failure === "revoke-ack") expect(reads).toBe(0);
      if (failure !== "clear-ack") expect(after.custody).toEqual(before.custody);
      else expect(after.custody[0]).toMatchObject({ state: "cleared", revision: "2" });
      wire.controls.before = undefined;
      wire.controls.after = undefined;
      expect(await (await admin(app, "DELETE", adminPath)).json()).toEqual({
        outcome: failure === "clear-ack" ? "unchanged" : "cleared",
        revision: 2,
      });
    },
  );
});
