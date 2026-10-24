import catalogManifest from "@chase-sets/catalog/context";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { admin, mounted, mint, unpair } from "./fixture";

afterEach(() => vi.restoreAllMocks());

it("does not expose bearer/hash/exception markers through retained grant routes", async () => {
  const bearer = "SYNTHETIC_GRANT_MARKER_8471".padEnd(43, "x");
  const hash = createHash("sha256").update(bearer).digest("hex");
  const exception = "SYNTHETIC_EXCEPTION_MARKER_8471";
  const fail = async () => {
    throw new Error([bearer, hash, exception].join(":"));
  };
  const pool: PgTransactionalPool = { connect: fail, query: fail };
  const app = mounted(catalogManifest, pool);
  const responses = [await admin(app), await unpair(app, bearer)];
  for (const response of responses) {
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "custody-unavailable" });
  }
  expect(JSON.stringify(responses)).not.toContain(exception);
});
