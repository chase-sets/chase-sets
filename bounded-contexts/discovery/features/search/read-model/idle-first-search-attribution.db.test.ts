import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildDiscoveryApi } from "../../../api";
import { module as discoveryModule } from "../../../index";
import { createDiscoveryServices } from "../../../support/runtime-support/services";
import {
  DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR,
  DISCOVERY_SEARCH_HYBRID_ENV_VAR,
  DISCOVERY_SEARCH_RESCUE_ENV_VAR,
  discoverySearchEmbeddingEnrichmentEnabled,
  discoverySearchHybridEnabled,
  discoverySearchRescueEnabled,
} from "../domain/embedding-rollout";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const correlationPrefix = "idle-first-search-10609";
const idleIntervalMs = 55_000;
const cycleCount = 4;

type ObservedFailure = Readonly<{
  correlationId: string;
  request: "blank" | "named" | "category" | "unknown";
  resource: string;
  errorClass: string;
  sqlStateCategory: string | null;
}>;

type ActiveRequest = Readonly<{
  correlationId: string;
  request: "blank" | "named" | "category";
}>;

type ObservedResource = Readonly<{
  correlationId: string;
  request: ActiveRequest["request"] | "unknown";
  resource: string;
  operation: string;
}>;

const localEmbeddingResource = "discovery-local-embedding-provider";

function createLocalDiscoveryEmbeddingProvider(
  observe: (observation: ObservedResource) => void,
  getActiveRequest: () => ActiveRequest | undefined,
): DiscoveryEmbeddingProvider {
  return {
    model: "local-diagnostic-embedding",
    dimensions: 1_024,
    embed: async (texts, inputType, options) => {
      const request = getActiveRequest();
      observe({
        correlationId: request?.correlationId ?? "unattributed",
        request: request?.request ?? "unknown",
        resource: localEmbeddingResource,
        operation: `embed-${inputType}`,
      });
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Local embedding was aborted.");
      return {
        vectors: texts.map((text) => {
          let hash = 2_166_136_261;
          for (const character of text) {
            hash ^= character.codePointAt(0) ?? 0;
            hash = Math.imul(hash, 16_777_619) >>> 0;
          }
          return Array.from({ length: 1_024 }, (_, index) => ((hash + index * 31) % 1_000) / 1_000);
        }),
        totalTokens: texts.reduce((total, text) => total + text.length, 0),
      };
    },
  };
}

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

function classifyError(error: unknown): { errorClass: string; sqlStateCategory: string | null } {
  const candidate = error as { constructor?: { name?: string }; code?: unknown };
  const errorClass = candidate.constructor?.name || "UnknownError";
  const code = typeof candidate.code === "string" && /^[A-Z0-9]{5}$/.test(candidate.code) ? candidate.code : null;
  return { errorClass, sqlStateCategory: code ? code.slice(0, 2) : null };
}

function withFailureCapture(
  pool: PgTransactionalPool,
  failures: ObservedFailure[],
  getActiveRequest: () => ActiveRequest | undefined,
): PgTransactionalPool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") {
        return async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          try {
            return await target.query<Row>(sql, values);
          } catch (error) {
            const classified = classifyError(error);
            const activeRequest = getActiveRequest();
            failures.push({
              correlationId: activeRequest?.correlationId ?? "unattributed",
              request: activeRequest?.request ?? "unknown",
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
  const trace: ObservedResource[] = [];
  let activeRequest: ActiveRequest | undefined;
  const effectiveFlags = {
    embeddings: discoverySearchEmbeddingEnrichmentEnabled({
      [DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR]: process.env[DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR],
    }),
    rescue: discoverySearchRescueEnabled({
      [DISCOVERY_SEARCH_RESCUE_ENV_VAR]: process.env[DISCOVERY_SEARCH_RESCUE_ENV_VAR],
    }),
    hybrid: discoverySearchHybridEnabled({
      [DISCOVERY_SEARCH_HYBRID_ENV_VAR]: process.env[DISCOVERY_SEARCH_HYBRID_ENV_VAR],
    }),
  };

  function classifyHookFailure(error: unknown, resource: "pool-idle-client" | "pool-active-client"): ObservedFailure {
    const request = activeRequest;
    return {
      correlationId: request?.correlationId ?? "unattributed",
      request: request?.request ?? "unknown",
      resource,
      ...classifyError(error),
    };
  }

  async function request(path: string, requestInfo: ActiveRequest): Promise<Response> {
    const previous = activeRequest;
    activeRequest = requestInfo;
    try {
      return await app.request(path, {
        headers: { "x-request-id": requestInfo.correlationId },
      });
    } finally {
      activeRequest = previous;
    }
  }

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), ["discovery"], "idle_first_search");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), urls);
    const rawPool = createPgPool(urls.discovery, {
      onIdleClientError: ({ error }) => failures.push(classifyHookFailure(error, "pool-idle-client")),
      onActiveClientError: ({ error }) => failures.push(classifyHookFailure(error, "pool-active-client")),
    });
    pool = rawPool;
    await resetMultiContextTestSchemas({ discovery: rawPool });
    await bootstrapContextDatabase(discoveryModule, rawPool);
    await seedFixture(rawPool);
    trace.push({
      correlationId: "setup",
      request: "unknown",
      resource: localEmbeddingResource,
      operation: "configured",
    });
    const services = createDiscoveryServices(
      withFailureCapture(rawPool, failures, () => activeRequest),
      {
        searchEmbeddingProvider: createLocalDiscoveryEmbeddingProvider(
          (observation) => trace.push(observation),
          () => activeRequest,
        ),
        searchEmbeddingConfig: {
          rolloutValue: process.env[DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR],
          rescueValue: process.env[DISCOVERY_SEARCH_RESCUE_ENV_VAR],
          hybridValue: process.env[DISCOVERY_SEARCH_HYBRID_ENV_VAR],
        },
      },
    );
    app = new Hono();
    app.route("/api/marketplace", buildDiscoveryApi(services));
  }, 120_000);

  afterAll(async () => {
    if (pool) await closeMultiContextTestPools({ discovery: pool });
  });

  it(
    "keeps blank and named first-after-idle searches healthy beside a category control",
    async () => {
      try {
        for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
          await sleep(idleIntervalMs);

          for (const [requestKind, path] of [
            ["blank", "/api/marketplace/items?sort=relevance&limit=24&includeTotal=true"],
            ["named", "/api/marketplace/items?search=charizard&sort=relevance&limit=24&includeTotal=true"],
          ] as const) {
            const firstCorrelationId = `${correlationPrefix}-${requestKind}-first-${cycle}`;
            const first = await request(path, { correlationId: firstCorrelationId, request: requestKind });
            if (first.status !== 200) {
              const failure = failures.find((candidate) => candidate.correlationId === firstCorrelationId);
              throw new Error(
                `idle-first-search failure correlation=${failure?.correlationId ?? firstCorrelationId} request=${requestKind} resource=${failure?.resource ?? "unknown"} errorClass=${failure?.errorClass ?? "UnknownError"} sqlStateCategory=${failure?.sqlStateCategory ?? "UNKNOWN"}`,
              );
            }
            const firstBody = (await first.json()) as { items?: Array<{ catalog_item_id?: string }>; total?: number };
            expect(firstBody.items?.[0]?.catalog_item_id, `cycle ${cycle} ${requestKind} result identity`).toBe(
              "idle-charizard",
            );
            expect(firstBody.total, `cycle ${cycle} ${requestKind} result count`).toBe(1);

            const secondCorrelationId = `${correlationPrefix}-${requestKind}-second-${cycle}`;
            const second = await request(path, { correlationId: secondCorrelationId, request: requestKind });
            expect(second.status, `cycle ${cycle} ${requestKind} immediate repeat`).toBe(200);
          }

          const categoryCorrelationId = `${correlationPrefix}-category-${cycle}`;
          const category = await request("/api/marketplace/categories", {
            correlationId: categoryCorrelationId,
            request: "category",
          });
          expect(category.status, `cycle ${cycle} category control`).toBe(200);
        }
      } finally {
        console.info(
          "idle-first-search-attribution",
          JSON.stringify({
            cycles: cycleCount,
            idleIntervalMs,
            effectiveFlags,
            fixture: "idle-charizard",
            failures,
            trace,
            outcome: failures.length === 0 ? "UNKNOWN_NO_EXCEPTION_OBSERVED" : "FAILURE_CLASSIFIED",
          }),
        );
      }
    },
    cycleCount * idleIntervalMs + 120_000,
  );
});
