import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildDiscoveryApi } from "../../../api";
import { module as discoveryModule } from "../../../index";
import { createDiscoveryServices } from "../../../support/runtime-support/services";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const correlationPrefix = "idle-first-search-10609";
const idleIntervalMs = 55_000;
const cycleCount = 4;

type ObservedFailure = Readonly<{
  correlationId: string;
  request: "blank" | "named" | "category";
  resource: string;
  errorClass: string;
  sqlState: string | null;
}>;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for the idle-first-search DB attribution lane.");
  }
  return databaseBaseUrl;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function classifyResource(sql: string): string {
  if (sql.includes("discovery_search_items")) return "discovery-search-read";
  if (sql.includes("discovery_categories")) return "discovery-category-read";
  return "discovery-other-read";
}

function classifyError(error: unknown): { errorClass: string; sqlState: string | null } {
  const candidate = error as { constructor?: { name?: string }; code?: unknown };
  const errorClass = candidate.constructor?.name || "UnknownError";
  const code = typeof candidate.code === "string" && /^[A-Z0-9]{5}$/.test(candidate.code) ? candidate.code : null;
  return { errorClass, sqlState: code };
}

function withFailureCapture(pool: PgTransactionalPool, failures: ObservedFailure[]): PgTransactionalPool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") {
        return async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          try {
            return await target.query<Row>(sql, values);
          } catch (error) {
            const classified = classifyError(error);
            failures.push({
              correlationId: `${correlationPrefix}-${failures.length + 1}`,
              request: sql.includes("discovery_categories")
                ? "category"
                : values?.some((value) => value === "charizard")
                  ? "named"
                  : "blank",
              resource: classifyResource(sql),
              ...classified,
            });
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PgTransactionalPool;
}

async function seedFixture(pool: PgTransactionalPool): Promise<void> {
  await pool.query("DELETE FROM discovery_search_items");
  await pool.query("DELETE FROM discovery_categories");
  await pool.query(
    `INSERT INTO discovery_categories
       (category_id, key, slug, name, description, status, display_order, item_count)
     VALUES ('idle-category', 'idle-category', 'idle-category', 'Idle category', 'Attribution control', 'active', 1, 1)`,
  );
  await pool.query(
    `INSERT INTO discovery_search_items
       (catalog_item_id, slug, title, status, category_slugs, search_text, search_text_simple)
     VALUES ('idle-charizard', 'idle-charizard', 'Charizard idle fixture', 'active', '["idle-category"]',
       to_tsvector('english', 'charizard idle fixture'), to_tsvector('simple', 'charizard idle fixture'))`,
  );
}

describe("idle-first-search dependency attribution (#10609)", () => {
  let pool: PgTransactionalPool;
  let app: Hono;
  const failures: ObservedFailure[] = [];

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), ["discovery"], "idle_first_search");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), urls);
    const rawPool = createMultiContextTestPools(urls).discovery;
    pool = rawPool;
    await resetMultiContextTestSchemas({ discovery: rawPool });
    await bootstrapContextDatabase(discoveryModule, rawPool);
    await seedFixture(rawPool);
    const services = createDiscoveryServices(withFailureCapture(rawPool, failures), {
      searchEmbeddingConfig: { rolloutValue: "disabled", rescueValue: "disabled", hybridValue: "disabled" },
    });
    app = new Hono();
    app.route("/api/marketplace", buildDiscoveryApi(services));
  }, 120_000);

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it(
    "keeps blank and named first-after-idle searches healthy beside a category control",
    async () => {
      const effectiveFlags = { embeddings: false, rescue: false, hybrid: false };
      for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
        await sleep(idleIntervalMs);
        const category = await app.request("/api/marketplace/categories", {
          headers: { "x-request-id": `${correlationPrefix}-category-${cycle}` },
        });
        expect(category.status, `cycle ${cycle} category control`).toBe(200);

        for (const [request, path] of [
          ["blank", "/api/marketplace/items?sort=relevance&limit=24&includeTotal=true"],
          ["named", "/api/marketplace/items?search=charizard&sort=relevance&limit=24&includeTotal=true"],
        ] as const) {
          const first = await app.request(path, {
            headers: { "x-request-id": `${correlationPrefix}-${request}-first-${cycle}` },
          });
          if (first.status !== 200) {
            const failure = failures.at(-1);
            throw new Error(
              `idle-first-search failure correlation=${failure?.correlationId ?? `${correlationPrefix}-${request}-first-${cycle}`} request=${request} resource=${failure?.resource ?? "unknown"} errorClass=${failure?.errorClass ?? "UnknownError"} sqlState=${failure?.sqlState ?? "UNKNOWN"}`,
            );
          }
          const firstBody = (await first.json()) as { items?: Array<{ catalog_item_id?: string }>; total?: number };
          expect(firstBody.items?.[0]?.catalog_item_id, `cycle ${cycle} ${request} result identity`).toBe(
            "idle-charizard",
          );
          expect(firstBody.total, `cycle ${cycle} ${request} result count`).toBe(1);

          const second = await app.request(path, {
            headers: { "x-request-id": `${correlationPrefix}-${request}-second-${cycle}` },
          });
          expect(second.status, `cycle ${cycle} ${request} immediate repeat`).toBe(200);
        }
      }

      console.info(
        "idle-first-search-attribution",
        JSON.stringify({
          cycles: cycleCount,
          idleIntervalMs,
          effectiveFlags,
          fixture: "idle-charizard",
          failures,
          outcome: failures.length === 0 ? "UNKNOWN_NO_EXCEPTION_OBSERVED" : "FAILURE_CLASSIFIED",
        }),
      );
    },
    cycleCount * idleIntervalMs + 120_000,
  );
});
