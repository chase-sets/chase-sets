import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../../index";
import {
  createPostgresTcgplayerAutomationHttpConfigStore,
  TCGPLAYER_AUTOMATION_DOMAIN_KEYS,
  TcgplayerAutomationAuthorityError,
  TcgplayerAutomationDomainHttpClient,
} from "./tcgplayer-automation-client";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("TCGplayer shared domain budget", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "tcgplayer_shared_budget");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("admits through one authority across independent store instances", async () => {
    const first = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const second = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const firstAdmission = await first.admitDomainRequest!(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      "api",
      30_000,
    );
    const secondAdmission = await second.admitDomainRequest!(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      "worker",
      30_000,
    );

    expect(firstAdmission.granted).toBe(true);
    expect(secondAdmission.granted).toBe(false);
    expect(Date.parse(secondAdmission.notBefore)).toBeGreaterThanOrEqual(Date.parse(secondAdmission.admittedAt));

    await first.releaseDomainLease!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API, firstAdmission.leaseId!, "api");
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limits SET last_request_started_at = clock_timestamp() - interval '1 minute' WHERE domain_key = $1",
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API],
    );
    const recovered = await second.admitDomainRequest!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API, "worker", 30_000);
    expect(recovered.granted).toBe(true);
    await second.releaseDomainLease!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API, recovered.leaseId!, "worker");
  });

  it("fences predecessor delay column names and reclaims expired leases", async () => {
    await expect(
      pools.catalog.query(
        "SELECT request_delay_ms, learned_min_delay_ms FROM catalog_tcgplayer_automation_domain_rate_limits",
      ),
    ).rejects.toBeDefined();

    const store = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const admission = await store.admitDomainRequest!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, "stale", 30_000);
    expect(admission.granted).toBe(true);
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limit_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE lease_id = $1",
      [admission.leaseId],
    );
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limits SET last_request_started_at = clock_timestamp() - interval '1 minute' WHERE domain_key = $1",
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY],
    );
    const reclaimed = await store.admitDomainRequest!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, "new", 30_000);
    expect(reclaimed.granted).toBe(true);
    await store.releaseDomainLease!(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, reclaimed.leaseId!, "new");
  });

  it("executes the production durable client branch and releases its lease on success", async () => {
    const first = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const second = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      "https://synthetic-provider.invalid",
      first,
      { fetch: fetchMock, sleep: async () => undefined },
    );

    await expect(client.get("/durable-success")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const state = await second.readDomainRateLimitState!();
    expect(state.find((row) => row.domainKey === TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API)).toMatchObject({
      liveLeaseCount: 0,
    });
  });

  it.each([403, 429])("records a durable shared cooldown after %i without provider retry traffic", async (status) => {
    const first = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog, { maxRetries: 0 });
    const second = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog, { maxRetries: 0 });
    const fetchMock = vi.fn(async () => textResponse("synthetic failure", { status }));
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY,
      "https://synthetic-provider.invalid",
      first,
      { fetch: fetchMock, sleep: async () => undefined },
    );

    await expect(client.get("/durable-failure")).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledOnce();
    await first.recordDomainRateLimit!(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY,
      { increaseMultiplier: 2, floorStepMs: 100, decreaseAmountMs: 100, successThreshold: 10 },
      10_000,
    );
    const state = await second.readDomainRateLimitState!();
    expect(state.find((row) => row.domainKey === TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY)).toMatchObject({
      cooldownUntil: expect.any(String),
    });
  });

  it("enforces durable spacing and concurrency across two production clients", async () => {
    const first = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const second = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    const makeClient = (store: typeof first) =>
      new TcgplayerAutomationDomainHttpClient(
        TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
        "https://synthetic-provider.invalid",
        store,
        { fetch: fetchMock },
      );

    const firstRequest = makeClient(first).get("/one");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const secondRequest = makeClient(second).get("/two");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const thirdRequest = makeClient(first).get("/three");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    responses[0]?.(jsonResponse({ request: 1 }));
    responses[1]?.(jsonResponse({ request: 2 }));
    await expect(firstRequest).resolves.toEqual({ request: 1 });
    await expect(secondRequest).resolves.toEqual({ request: 2 });
    await pools.catalog.query(
      "UPDATE catalog_tcgplayer_automation_domain_rate_limits SET last_request_started_at = clock_timestamp() - interval '1 minute' WHERE domain_key = $1",
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API],
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    responses[2]?.(jsonResponse({ request: 3 }));
    await expect(thirdRequest).resolves.toEqual({ request: 3 });
  });

  it("aborts before durable admission without provider traffic", async () => {
    const store = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY,
      "https://synthetic-provider.invalid",
      store,
      { fetch: fetchMock },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(client.get("/aborted", {}, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts after durable admission and releases the lease", async () => {
    const store = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY,
      "https://synthetic-provider.invalid",
      store,
      { fetch: fetchMock },
    );
    const request = client.get("/abort-after-admission", {}, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toBeDefined();
    const state = await store.readDomainRateLimitState!();
    expect(state.find((row) => row.domainKey === TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY)).toMatchObject({
      liveLeaseCount: 0,
    });
  });

  it("fails closed when renewal is rejected and releases durable authority", async () => {
    const store = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const renew = vi.spyOn(store, "renewDomainLease").mockResolvedValue(false);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY,
      "https://synthetic-provider.invalid",
      store,
      { fetch: fetchMock, sleep: async () => undefined },
    );

    await expect(client.get("/renewal-rejected")).rejects.toBeInstanceOf(TcgplayerAutomationAuthorityError);
    expect(renew).toHaveBeenCalled();
    const state = await store.readDomainRateLimitState!();
    expect(state.find((row) => row.domainKey === TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY)).toMatchObject({
      liveLeaseCount: 0,
    });
  });

  it("fences lost authority commits and accepts only the current epoch success", async () => {
    const first = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const second = createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog);
    const domainKey = TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY;
    const admission = await first.admitDomainRequest!(domainKey, "epoch-owner", 30_000);
    expect(admission.granted).toBe(true);
    await first.releaseDomainLease!(domainKey, admission.leaseId!, "epoch-owner");
    const beforeStale = await pools.catalog.query<{
      effective_request_delay_ms: number;
      effective_learned_min_delay_ms: number;
      shared_success_streak: number;
      epoch: number;
    }>(
      `SELECT effective_request_delay_ms,
              effective_learned_min_delay_ms,
              shared_success_streak,
              epoch
         FROM catalog_tcgplayer_automation_domain_rate_limits
        WHERE domain_key = $1`,
      [domainKey],
    );
    const stale = await first.recordDomainSuccess!(
      domainKey,
      { increaseMultiplier: 2, floorStepMs: 100, decreaseAmountMs: 100, successThreshold: 2 },
      admission.epoch - 1,
    );
    expect(stale).toBeDefined();
    const afterStale = await pools.catalog.query(
      `SELECT effective_request_delay_ms,
              effective_learned_min_delay_ms,
              shared_success_streak,
              epoch
         FROM catalog_tcgplayer_automation_domain_rate_limits
        WHERE domain_key = $1`,
      [domainKey],
    );
    expect(afterStale.rows).toEqual(beforeStale.rows);
    const current = await second.recordDomainSuccess!(
      domainKey,
      { increaseMultiplier: 2, floorStepMs: 100, decreaseAmountMs: 100, successThreshold: 2 },
      admission.epoch,
    );
    expect(current).toBeDefined();
    const afterCurrent = await pools.catalog.query(
      "SELECT shared_success_streak FROM catalog_tcgplayer_automation_domain_rate_limits WHERE domain_key = $1",
      [domainKey],
    );
    expect(afterCurrent.rows).toEqual([{ shared_success_streak: 1 }]);
  });
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}
