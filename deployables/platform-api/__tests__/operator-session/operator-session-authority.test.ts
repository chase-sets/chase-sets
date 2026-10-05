import catalogManifest from "@chase-sets/catalog/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  discoverDbProfile,
  validateDbProfileScripts,
} from "../../../../scripts/check-structure/db-profile-script-canonical-form.mjs";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { admin, adminPath, base, deniedOrigins, mounted, operator, publicPath, session } from "./fixture";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function refusedPool() {
  const connect = vi.fn(async () => {
    throw new Error("synthetic-custody-refusal");
  });
  const query = vi.fn(async () => {
    throw new Error("unexpected unbound query");
  });
  const pool: PgTransactionalPool = { connect, query };
  return { pool, connect, query };
}
describe("mounted operator-session admission", () => {
  it("enrolls every new DB proof in the required DB profile and excludes it only from unit/fast", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const dir = fileURLToPath(new URL("../../", import.meta.url));
    expect(validateDbProfileScripts({ name: manifest.name, dir, packageJson: manifest }).violations).toEqual([]);
    const inventory = discoverDbProfile(dir, ["test:db:1", "test:db:2"]);
    for (const name of ["grant-mint", "grant-lifecycle", "grant-scope", "push"]) {
      const path = `__tests__/db/unit-2/operator-session/operator-session-${name}.db.test.ts`;
      expect(inventory.units.find((unit) => unit.name === "test:db:2")!.files).toContain(path);
      expect(inventory.unit.files).not.toContain(path);
    }
  });
  it("denies each independent authority dimension before custody; authorized control reaches custody", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const pool = refusedPool();
    for (const [actor, status] of [
      [null, 401],
      [operator({ roleKey: "account-admin" }), 403],
      [operator({ permissions: [] }), 403],
      [operator({ authenticatedAt: null }), 400],
      [operator({ authenticatedAt: "invalid" }), 400],
      [operator({ authenticatedAt: new Date(now - 600_001).toISOString() }), 400],
      [operator({ authenticatedAt: new Date(now + 1).toISOString() }), 400],
    ] as const) {
      for (const method of ["POST", "DELETE"]) {
        const response = await admin(
          mounted(catalogManifest, pool.pool, { actor }),
          method,
          method === "POST" ? adminPath + "/grant" : adminPath,
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    const app = mounted(catalogManifest, pool.pool);
    for (const headers of deniedOrigins) {
      expect((await admin(app, "POST", adminPath + "/grant", headers)).status).toBe(403);
    }
    expect(pool.connect).not.toHaveBeenCalled();
    expect((await admin(app)).status).toBe(503);
    expect(pool.connect).toHaveBeenCalledOnce();
    const boundary = mounted(catalogManifest, pool.pool, {
      actor: operator({ authenticatedAt: new Date(now - 600_000).toISOString() }),
    });
    expect((await admin(boundary)).status).toBe(503);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
  it("the fixed global 120/min bucket precedes body and DB, ignoring attacker token/IP keys", async () => {
    const pool = refusedPool();
    const app = mounted(catalogManifest, pool.pool, { actor: null });
    for (let i = 0; i < 120; i++) {
      const response = await app.request(base + publicPath + "/tcgplayer", {
        method: "PUT",
        headers: { authorization: "invalid-" + i, "x-forwarded-for": "synthetic-" + i },
      });
      expect(response.status).toBe(401);
    }
    const pull = vi.fn();
    const init = {
      method: "PUT",
      headers: { authorization: "Bearer " + "x".repeat(43), "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
      duplex: "half",
    };
    const response = await app.fetch(new Request(base + publicPath + "/tcgplayer", init));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it("four slow bodies include Admin slots; five-second cancellation frees every slot", async () => {
    vi.useFakeTimers();
    const pool = refusedPool();
    const app = mounted(catalogManifest, pool.pool);
    const cancelled = vi.fn();
    const pending = Array.from({ length: 4 }, (_, index) => {
      const init = {
        method: index ? "PUT" : "POST",
        headers: { origin: base, authorization: "Bearer " + "x".repeat(43), "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ cancel: cancelled }),
        duplex: "half",
      };
      return app.fetch(new Request(base + (index ? publicPath + "/tcgplayer" : adminPath + "/grant"), init));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await admin(app)).status).toBe(429);
    await vi.advanceTimersByTimeAsync(5000);
    for (const response of await Promise.all(pending)) expect(response.status).toBe(408);
    expect(cancelled).toHaveBeenCalledTimes(4);
    expect(pool.connect).not.toHaveBeenCalled();
    expect((await admin(app)).status).toBe(503);
    expect(pool.connect).toHaveBeenCalledOnce();
  });
  it("missing credentials never reach body or backend and malformed bodies never reach custody", async () => {
    const pool = refusedPool();
    const app = mounted(catalogManifest, pool.pool);
    const invalidCredentials: readonly HeadersInit[] = [
      { cookie: "grant=" + "x".repeat(43) },
      { authorization: "bearer " + "x".repeat(43) },
    ];
    for (const headers of invalidCredentials) {
      expect((await app.request(base + publicPath + "/tcgplayer", { method: "PUT", headers })).status).toBe(401);
    }
    const response = await app.request(base + publicPath + "/tcgplayer", {
      method: "PUT",
      headers: { authorization: "Bearer " + "x".repeat(43), "content-type": "application/json" },
      body: JSON.stringify({ ...session(), token: "not-authority" }),
    });
    expect(response.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
