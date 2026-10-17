import catalogManifest from "@chase-sets/catalog/context";
import { afterEach, expect, it, vi } from "vitest";
import {
  admin,
  adminPath,
  base,
  keyring,
  mint,
  mounted,
  publicPath,
  push,
  session,
  snapshot,
  transport,
  unpair,
} from "./fixture";
import { database, describeDb } from "./db-fixture";

afterEach(() => vi.useRealTimers());
describeDb("public bearer scope and pre-commit refusal atomicity", () => {
  const db = database("operator_grant_scope");
  it("bearer alone authorizes only the two public methods; cookie/actor/query/body never do", async () => {
    const grant = await mint(mounted(catalogManifest, db()));
    const app = mounted(catalogManifest, db(), { actor: null });
    expect((await push(app, grant)).status).toBe(200);
    const before = await snapshot(db());
    for (const authorization of ["", "bearer " + grant, "Bearer " + "x".repeat(43)]) {
      const response = await app.request(base + publicPath + "/tcgplayer?grant=" + grant, {
        method: "PUT",
        headers: { authorization, cookie: "chase_sets_session=" + grant, "content-type": "application/json" },
        body: JSON.stringify(session(1)),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: "grant-invalid" });
    }
    for (const path of [adminPath, adminPath + "/grant", publicPath + "/unknown", publicPath + "/tcgplayer"]) {
      const response = await app.request(base + path, { headers: { authorization: "Bearer " + grant } });
      expect([401, 404]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    expect(await snapshot(db())).toEqual(before);
    expect((await unpair(app, grant)).status).toBe(200);
    const revoked = await snapshot(db());
    expect(revoked.custody).toEqual(before.custody);
    expect(revoked.grants[0]!.last_used_at).toEqual(before.grants[0]!.last_used_at);
    expect((await unpair(app, grant)).status).toBe(401);
    expect((await push(app, grant, session(1))).status).toBe(401);
    expect(await snapshot(db())).toEqual(revoked);
  });
  it("strict DB expiry never revives and next-day pushes renew only valid grants", async () => {
    const wire = transport(db());
    wire.controls.now = new Date("2026-12-01T00:00:00.000Z");
    const app = mounted(catalogManifest, wire.pool);
    const grant = await mint(app);
    wire.controls.now = new Date("2026-12-02T00:00:00.000Z");
    expect((await push(app, grant)).status).toBe(200);
    const before = await snapshot(db());
    wire.controls.now = new Date("2027-01-01T00:00:00.000Z");
    expect((await push(app, grant, session(1))).status).toBe(401);
    expect((await unpair(app, grant)).status).toBe(401);
    expect(await snapshot(db())).toEqual(before);
    expect(await (await admin(app, "GET", adminPath, {})).json()).toMatchObject({ grant: { active: false } });
  });
  it.each([
    [null, 400],
    [[], 400],
    [{ ...session(), extra: true }, 400],
    [{ ...session(), expectedRevision: "0" }, 400],
    [{ ...session(), expectedRevision: -1 }, 400],
    [{ ...session(), expectedRevision: 9007199254740992 }, 400],
    [{ ...session(), observedAt: "2026-02-30T00:00:00Z" }, 400],
    [{ ...session(), browserExpiresAt: "2026-10-01" }, 400],
    [{ ...session(), value: "bad;cookie" }, 422],
    [{ ...session(), value: "x".repeat(4097) }, 422],
  ] as const)("closed request refusal %# leaves both tables unchanged", async (input, status) => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    const before = await snapshot(db());
    expect((await push(app, grant, input)).status).toBe(status);
    expect(await snapshot(db())).toEqual(before);
  });
  it("largest valid, chunked cap+1, wrong media and empty-route body controls use actual bytes", async () => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    expect((await push(app, grant, session(0, "x".repeat(4096)))).status).toBe(200);
    const before = await snapshot(db());
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(++chunks === 1 ? 8192 : 1).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "PUT",
      headers: { authorization: "Bearer " + grant, "content-type": "application/json", "content-length": "1" },
      body,
      duplex: "half",
    };
    const response = await app.fetch(new Request(base + publicPath + "/tcgplayer", init));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(
      (
        await app.request(base + publicPath + "/tcgplayer", {
          method: "PUT",
          headers: { authorization: "Bearer " + grant },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request(base + publicPath + "/grant", {
          method: "DELETE",
          headers: { authorization: "Bearer " + grant },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(await snapshot(db())).toEqual(before);
  });
  it("six PUTs per valid id, no renewal at 429, expiry of the replica window restores admission", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    for (let i = 0; i < 6; i++) expect((await push(app, grant, session(i ? 1 : 0))).status).toBe(200);
    const before = await snapshot(db());
    const limited = await push(app, grant, session(1));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await snapshot(db())).toEqual(before);
    vi.setSystemTime(now + 60_001);
    expect((await push(app, grant, session(1))).status).toBe(200);
  });
  it.each(["custody-sql", "lost-key", "sealing"] as const)(
    "renewal-first fault control rolls back renewal on %s refusal",
    async (fault) => {
      const keys = { activeKeyId: keyring.activeKeyId, keys: new Map(keyring.keys) };
      const wire = transport(db());
      const app = mounted(catalogManifest, wire.pool, { keys });
      const grant = await mint(app);
      const before = await snapshot(db());
      let executedRenewal = false;
      wire.controls.before = async (sql, _values, client) => {
        if (!sql.startsWith("SELECT * FROM catalog_tcgplayer_operator_sessions")) return;
        // Test-only ordering control: real renewal on the same uncommitted backend before the real accept.
        await client.query(
          "UPDATE catalog_operator_session_grants SET last_used_at = clock_timestamp(), idle_expires_at = clock_timestamp() + interval '30 days' WHERE revoked_at IS NULL",
        );
        executedRenewal = true;
        if (fault === "custody-sql") await client.query("SELECT 1 / 0");
        if (fault === "lost-key") keys.keys.clear();
        if (fault === "sealing") keys.keys.set(keys.activeKeyId, new Uint8Array(1));
      };
      expect((await push(app, grant)).status).toBe(503);
      expect(executedRenewal).toBe(true);
      expect(await snapshot(db()), "different observer connection after rollback").toEqual(before);
      expect(wire.live).toBe(0);
    },
  );
  it.each(["sql", "conditional-expiry"] as const)(
    "accept-first %s renewal refusal rolls back real custody",
    async (fault) => {
      const wire = transport(db());
      const app = mounted(catalogManifest, wire.pool);
      const grant = await mint(app);
      const before = await snapshot(db());
      let custodyExecuted = false;
      wire.controls.after = async (sql) => {
        if (sql.startsWith("INSERT INTO catalog_tcgplayer_operator_sessions")) custodyExecuted = true;
      };
      wire.controls.before = async (sql, _values, client) => {
        if (!sql.includes("SET last_used_at = instant.t")) return;
        expect(custodyExecuted).toBe(true);
        if (fault === "sql") await client.query("SELECT 1 / 0");
        else
          await client.query(
            "UPDATE catalog_operator_session_grants SET idle_expires_at = clock_timestamp() - interval '1 day'",
          );
      };
      expect((await push(app, grant)).status).toBe(fault === "sql" ? 503 : 401);
      expect(custodyExecuted).toBe(true);
      expect(await snapshot(db())).toEqual(before);
      expect(wire.live).toBe(0);
    },
  );
  it("missing write key refuses even stale PUT; actual maximum-revision increment refuses without renewal", async () => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    await push(app, grant);
    const before = await snapshot(db());
    expect((await push(mounted(catalogManifest, db(), { keys: null }), grant)).status).toBe(503);
    expect(await snapshot(db())).toEqual(before);
    await db().query(`UPDATE catalog_tcgplayer_operator_sessions SET revision = 9007199254740990,
      state = 'cleared', ciphertext = NULL, iv = NULL, tag = NULL,
      stored_at = NULL, observed_at = NULL, browser_expires_at = NULL`);
    expect(await (await push(app, grant, session(Number.MAX_SAFE_INTEGER - 1, "maximum-value"))).json()).toEqual({
      outcome: "stored",
      revision: Number.MAX_SAFE_INTEGER,
    });
    const full = (await snapshot(db())).custody;
    expect(await (await push(app, grant, session(Number.MAX_SAFE_INTEGER, "maximum-value"))).json()).toEqual({
      outcome: "unchanged",
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect((await snapshot(db())).custody).toEqual(full);
    const maximum = await snapshot(db());
    const response = await push(app, grant, session(Number.MAX_SAFE_INTEGER, "new-value"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "revision-exhausted" });
    expect(await snapshot(db())).toEqual(maximum);
  });
  it("endless authenticated and empty-route bodies cancel without durable effects", async () => {
    const app = mounted(catalogManifest, db());
    const grant = await mint(app);
    const before = await snapshot(db());
    for (const method of ["PUT", "DELETE", "POST"]) {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const init = {
        method,
        headers: { origin: base, authorization: "Bearer " + grant, "content-type": "application/json" },
        body,
        duplex: "half",
      };
      const path =
        method === "PUT"
          ? publicPath + "/tcgplayer"
          : method === "DELETE"
            ? publicPath + "/grant"
            : adminPath + "/grant";
      const pending = app.fetch(new Request(base + path, init));
      await vi.advanceTimersByTimeAsync(5000);
      const response = await pending;
      expect(response.status).toBe(408);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      vi.useRealTimers();
      expect(await snapshot(db())).toEqual(before);
    }
  });
});
