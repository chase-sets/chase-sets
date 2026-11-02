import catalogManifest from "@chase-sets/catalog/context";
import { afterEach, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { admin, adminPath, base, deniedOrigins, mounted, operator } from "./fixture";

afterEach(() => vi.useRealTimers());

function refusedPool(): PgTransactionalPool {
  return {
    connect: async () => {
      throw new Error("synthetic-custody-refusal");
    },
    query: async () => {
      throw new Error("unexpected unbound query");
    },
  };
}

it("denies independent admin authority dimensions before the retained grant backend", async () => {
  const pool = refusedPool();
  for (const [actor, status] of [
    [null, 401],
    [operator({ roleKey: "account-admin" }), 403],
    [operator({ permissions: [] }), 403],
    [operator({ authenticatedAt: null }), 400],
  ] as const) {
    const response = await admin(mounted(catalogManifest, pool, { actor }), "POST", adminPath + "/grant");
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const app = mounted(catalogManifest, pool);
  for (const headers of deniedOrigins)
    expect((await admin(app, "POST", adminPath + "/grant", headers)).status).toBe(403);
  expect((await admin(app)).status).toBe(503);
});

it("applies the fixed global rate limit before backend access", async () => {
  const pool = refusedPool();
  const app = mounted(catalogManifest, pool, { actor: null });
  for (let i = 0; i < 120; i++) {
    const response = await app.request(base + "/api/public/catalog/operator-session/grant", {
      method: "DELETE",
      headers: { authorization: "Bearer invalid-" + i },
    });
    expect(response.status).toBe(401);
  }
  const response = await app.request(base + "/api/public/catalog/operator-session/grant", {
    method: "DELETE",
    headers: { authorization: "Bearer " + "x".repeat(43) },
  });
  expect([401, 429]).toContain(response.status);
});
