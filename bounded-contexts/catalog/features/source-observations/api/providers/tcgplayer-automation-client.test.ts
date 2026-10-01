import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  createPostgresTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationHttpClients,
  DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG,
  DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
  TCGPLAYER_AUTOMATION_DOMAIN_KEYS,
  TcgplayerAutomationAuthorityError,
  TcgplayerAutomationDomainHttpClient,
  TcgplayerAutomationHttpError,
  redactTcgplayerAutomationProviderDiagnostic,
  type TcgplayerAutomationHttpConfig,
  type TcgplayerAutomationStageFact,
} from "./tcgplayer-automation-client";

describe("TCGplayer automation HTTP client", () => {
  it("matches only an own credential refusal code without reading exception text or getters", async () => {
    const message = vi.fn(() => {
      throw new Error("synthetic-private-exception-text");
    });
    const own = Object.defineProperty({ code: "credential-unavailable" }, "message", { get: message });
    const inherited = Object.create({ code: "credential-unavailable" });
    const codeGetter = vi.fn(() => "credential-unavailable");
    const accessor = Object.defineProperty({}, "code", { get: codeGetter });
    for (const [error, failureCode] of [
      [own, "credential-unavailable"],
      [inherited, null],
      [accessor, null],
    ] as const) {
      const store = createInMemoryTcgplayerAutomationHttpConfigStore();
      vi.spyOn(store, "loadConfig").mockRejectedValue(error);
      const facts: TcgplayerAutomationStageFact[] = [];
      const client = new TcgplayerAutomationDomainHttpClient(
        TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI,
        "https://synthetic-provider.invalid",
        store,
      );
      await expect(client.get("/refusal", {}, { onStage: (fact) => facts.push(fact) })).rejects.toBe(error);
      expect(facts.at(-1)).toMatchObject({
        stage: "terminal",
        outcome: "failure",
        failureCode,
        lastHttpStatus: null,
        lastHttpStatusAttempt: null,
      });
      expect(JSON.stringify(facts)).not.toContain("synthetic-private-exception-text");
    }
    expect(message).not.toHaveBeenCalled();
    expect(codeGetter).not.toHaveBeenCalled();
  });

  it.each([403, 429])(
    "characterizes the unchanged %i retry, cooldown, learning and terminal outcome",
    async (status) => {
      const sequence: unknown[] = [];
      const store = createInMemoryTcgplayerAutomationHttpConfigStore({
        maxRetries: 1,
        adaptiveConfig: { ...DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG, successThreshold: 1 },
      });
      const persist = store.persistDomainDelays;
      vi.spyOn(store, "persistDomainDelays").mockImplementation(async (domain, delays) => {
        sequence.push(["write", domain, delays]);
        await persist(domain, delays);
      });
      let fetches = 0;
      let clock = Date.parse("2026-09-01T00:00:00.000Z");
      const client = new TcgplayerAutomationDomainHttpClient(
        TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI,
        "https://synthetic-provider.invalid",
        store,
        {
          now: () => clock,
          fetch: async () => {
            sequence.push(["fetch", ++fetches]);
            return fetches === 1 ? textResponse("private", { status }) : jsonResponse({ recovered: true });
          },
          sleep: async (ms) => {
            sequence.push(["sleep", ms]);
            clock += ms;
          },
        },
      );
      const result = await client.get(
        "/synthetic",
        {},
        {
          onStage: (fact) => {
            if (["retry-start", "cooldown-start", "cooldown-end", "retry-end", "terminal"].includes(fact.stage))
              sequence.push([fact.stage, fact.attempt, fact.outcome ?? null]);
          },
        },
      );
      expect(result).toEqual({ recovered: true });
      expect(sequence).toEqual([
        ["fetch", 1],
        ["retry-start", 1, null],
        ["cooldown-start", 1, null],
        ["write", "mpApi", { requestDelayMs: 200, learnedMinDelayMs: 100 }],
        ["sleep", 10000],
        ["cooldown-end", 1, null],
        ["retry-end", 1, null],
        ["fetch", 2],
        ["write", "mpApi", { requestDelayMs: 100, learnedMinDelayMs: 100 }],
        ["terminal", 2, "success"],
      ]);
    },
  );

  it("records pre-fetch abort and pending-fetch abort without requiring fetch to settle", async () => {
    const facts: TcgplayerAutomationStageFact[] = [];
    const slowStore = createInMemoryTcgplayerAutomationHttpConfigStore({ maxRetries: 0 });
    let releaseConfig!: (value: TcgplayerAutomationHttpConfig) => void;
    const config = await slowStore.loadConfig();
    vi.spyOn(slowStore, "loadConfig").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConfig = resolve;
        }),
    );
    const fetchMock = vi.fn(async () => new Promise<Response>(() => undefined));
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
      "https://synthetic-provider.invalid",
      slowStore,
      { fetch: fetchMock, now: () => Date.parse("2026-09-01T00:00:00.000Z") },
    );
    const before = new AbortController();
    const first = client.get("/first", {}, { signal: before.signal, onStage: (fact) => facts.push(fact) });
    before.abort();
    expect(facts.map((fact) => fact.stage)).toEqual(["config-wait", "abort", "terminal"]);
    expect(facts[1]).toMatchObject({ activeStage: "config-wait", attempt: 1 });
    releaseConfig(config);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();

    facts.length = 0;
    const during = new AbortController();
    void client.get("/pending", {}, { signal: during.signal, onStage: (fact) => facts.push(fact) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    during.abort();
    expect(facts.slice(-3).map((fact) => fact.stage)).toEqual(["fetch-start", "abort", "terminal"]);
    expect(facts.at(-2)).toMatchObject({ activeStage: "fetch-start", at: "2026-09-01T00:00:00.000Z" });
    expect(facts.at(-1)).toMatchObject({ outcome: "aborted" });
    expect(facts.some((fact) => fact.stage === "headers-received")).toBe(false);
  });

  it.each([403, 429])("records %i headers before cooldown and a second attempt", async (status) => {
    const facts: TcgplayerAutomationStageFact[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("secret-body", { status }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = clientWithConfig(
      { maxRetries: 1 },
      { fetch: fetchMock, now: () => Date.parse("2026-09-01T00:00:00.000Z") },
    );
    await expect(client.get("/retry", {}, { onStage: (fact) => facts.push(fact) })).resolves.toEqual({ ok: true });
    const stages = facts.map((fact) => `${fact.attempt}:${fact.stage}`);
    expect(stages).toEqual([
      "1:config-wait",
      "1:config-wait",
      "1:limiter-wait",
      "1:throttle-wait",
      "1:request-construction",
      "1:fetch-start",
      "1:headers-received",
      "1:error-body-read-start",
      "1:error-body-read-end",
      "1:retry-start",
      "1:cooldown-start",
      "1:cooldown-end",
      "1:retry-end",
      "2:config-wait",
      "2:limiter-wait",
      "2:throttle-wait",
      "2:request-construction",
      "2:fetch-start",
      "2:headers-received",
      "2:parse-start",
      "2:parse-end",
      "2:terminal",
    ]);
    expect(facts.filter((fact) => fact.stage === "headers-received").map((fact) => fact.statusClass)).toEqual([
      "4xx",
      "2xx",
    ]);
    expect(JSON.stringify(facts)).not.toContain("secret-body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains a terminal for an out-of-range response status without emitting httpStatus", async () => {
    const facts: TcgplayerAutomationStageFact[] = [];
    const response = { status: 600, ok: false, text: async () => "synthetic" } as Response;
    const client = clientWithConfig({ maxRetries: 0 }, { fetch: vi.fn().mockResolvedValue(response) });
    await expect(client.get("/out-of-range", {}, { onStage: (fact) => facts.push(fact) })).rejects.toThrow();
    expect(facts.find((fact) => fact.stage === "headers-received")).toMatchObject({ statusClass: "other" });
    expect(facts.find((fact) => fact.stage === "headers-received")).not.toHaveProperty("httpStatus");
    expect(facts.at(-1)).toMatchObject({
      stage: "terminal",
      outcome: "failure",
      lastHttpStatus: null,
      lastHttpStatusAttempt: null,
    });
  });

  it("records status before backoff and abort within a rate-limit cooldown", async () => {
    const backoff: TcgplayerAutomationStageFact[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("private", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = clientWithConfig({ maxRetries: 1 }, { fetch: fetchMock, random: () => 0 });
    await expect(client.get("/retry", {}, { onStage: (fact) => backoff.push(fact) })).resolves.toEqual({ ok: true });
    expect(backoff.map((fact) => fact.stage)).toEqual(
      expect.arrayContaining([
        "headers-received",
        "error-body-read-start",
        "error-body-read-end",
        "retry-backoff-start",
        "retry-backoff-end",
      ]),
    );
    expect(backoff.find((fact) => fact.stage === "headers-received")?.statusClass).toBe("5xx");
    const cooldown: TcgplayerAutomationStageFact[] = [];
    const controller = new AbortController();
    const limited = clientWithConfig(
      { maxRetries: 1 },
      {
        fetch: vi.fn(async () => textResponse("private", { status: 429 })),
        sleep: async (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
    );
    const pending = limited.get("/limited", {}, { signal: controller.signal, onStage: (fact) => cooldown.push(fact) });
    await vi.waitFor(() => expect(cooldown.some((fact) => fact.stage === "cooldown-start")).toBe(true));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cooldown.slice(-2)).toMatchObject([
      { stage: "abort", activeStage: "cooldown-start" },
      { stage: "terminal", outcome: "aborted" },
    ]);
    expect(cooldown.find((fact) => fact.stage === "headers-received")?.statusClass).toBe("4xx");
  });

  it("records parse failure, releases the limiter, and ignores an observer that throws", async () => {
    const facts: TcgplayerAutomationStageFact[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("synthetic-secret-body", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ recovered: true }));
    const client = clientWithConfig(
      { maxRetries: 0, domainConfigs: domainConfigs({ maxConcurrentRequests: 1 }) },
      { fetch: fetchMock },
    );
    await expect(
      client.get(
        "/bad",
        {},
        {
          onStage: (fact) => {
            facts.push(fact);
            throw new Error("synthetic-secret-observer");
          },
        },
      ),
    ).rejects.toThrow();
    await expect(client.get("/healthy")).resolves.toEqual({ recovered: true });
    expect(facts.slice(-4).map((fact) => fact.stage)).toEqual([
      "headers-received",
      "parse-start",
      "parse-failure",
      "terminal",
    ]);
    expect(facts.at(-1)).toMatchObject({ outcome: "failure" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(facts)).not.toMatch(/synthetic-secret-body|synthetic-secret-observer/);
  });
  it("rejects an aborted throttle wait and lets later requests retain their own signal and spacing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    try {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({ ok: true }));
      const client = new TcgplayerAutomationDomainHttpClient(
        TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
        "https://mp-search-api.tcgplayer.com",
        createInMemoryTcgplayerAutomationHttpConfigStore({
          maxRetries: 0,
          domainConfigs: domainConfigs({ requestDelayMs: 1_000, maxConcurrentRequests: 3, adaptiveEnabled: false }),
        }),
        { fetch: fetchMock },
      );
      await client.get("/prime");
      const controller = new AbortController();
      let abortedOutcome: unknown;
      const aborted = client.get("/aborted", {}, { signal: controller.signal }).catch((error: unknown) => {
        abortedOutcome = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      const later = client.get("/later");
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(abortedOutcome).toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(later).resolves.toEqual({ ok: true });
      await aborted;
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        "https://mp-search-api.tcgplayer.com/prime",
        "https://mp-search-api.tcgplayer.com/later",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a queued throttle request immediately without canceling the active waiter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
      const client = new TcgplayerAutomationDomainHttpClient(
        TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
        "https://mp-search-api.tcgplayer.com",
        createInMemoryTcgplayerAutomationHttpConfigStore({
          maxRetries: 0,
          domainConfigs: domainConfigs({ requestDelayMs: 1_000, maxConcurrentRequests: 3, adaptiveEnabled: false }),
        }),
        { fetch: fetchMock },
      );
      await client.get("/prime");
      const active = client.get("/active");
      const controller = new AbortController();
      let queuedOutcome: unknown;
      const queued = client.get("/queued", {}, { signal: controller.signal }).catch((error: unknown) => {
        queuedOutcome = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(queuedOutcome).toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(active).resolves.toEqual({ ok: true });
      await queued;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a throttle configuration failure and recovers for the next request", async () => {
    const store = createInMemoryTcgplayerAutomationHttpConfigStore({
      maxRetries: 0,
      domainConfigs: domainConfigs({ requestDelayMs: 0, maxConcurrentRequests: 1, adaptiveEnabled: false }),
    });
    const config = await store.loadDomainConfig(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API);
    const failure = new Error("Synthetic configuration failure");
    vi.spyOn(store, "loadDomainConfig").mockResolvedValueOnce(config).mockRejectedValueOnce(failure);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
      "https://mp-search-api.tcgplayer.com",
      store,
      { fetch: fetchMock },
    );
    await expect(client.get("/failed")).rejects.toBe(failure);
    await expect(client.get("/recovered")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an already-aborted request before starting a provider call", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = clientWithConfig({ maxRetries: 0 }, { fetch: fetchMock });
    const controller = new AbortController();
    controller.abort();
    await expect(client.get("/aborted", {}, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the automation-app cookie and user agent without exposing them in provider errors", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return jsonResponse({ ok: true });
    });
    const client = clientWithConfig(
      {
        auth: { tcgAuthCookie: "secret-cookie", userAgent: "Catalog Test Agent" },
        maxRetries: 0,
      },
      { fetch: fetchMock },
    );

    await expect(client.get("/v1/products", { q: "furret" })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url).toBe("https://mp-search-api.tcgplayer.com/v1/products?q=furret");
    expect(requests[0]?.headers.get("User-Agent")).toBe("Catalog Test Agent");
    expect(requests[0]?.headers.get("Cookie")).toBe("TCGAuthTicket_Production=secret-cookie;");
  });

  it("omits the provider cookie when it is missing and redacts auth failure diagnostics", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return textResponse(
        'expired TCGAuthTicket_Production=secret-cookie {"sellerId":12345,"sellerName":"seller-name"}',
        { status: 403 },
      );
    });
    const client = clientWithConfig(
      {
        auth: { tcgAuthCookie: null, userAgent: "Catalog Test Agent" },
        maxRetries: 0,
      },
      { fetch: fetchMock },
    );

    await expect(client.get("/v1/products", { q: "furret" })).rejects.toMatchObject({
      name: "TcgplayerAutomationHttpError",
      status: 403,
      responseBody: 'expired TCGAuthTicket_Production=<redacted> {"sellerId":"<redacted>","sellerName":"<redacted>"}',
    } satisfies Partial<TcgplayerAutomationHttpError>);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0]?.headers.get("Cookie")).toBeNull();
  });

  it("retries automation-app retryable statuses and persists adaptive rate-limit delays", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const store = createInMemoryTcgplayerAutomationHttpConfigStore({
      maxRetries: 1,
      domainConfigs: domainConfigs({
        requestDelayMs: 0,
        rateLimitCooldownMs: 50,
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ recovered: true }));
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
      "https://mp-search-api.tcgplayer.com",
      store,
      {
        fetch: fetchMock,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );

    await expect(client.get("/search")).resolves.toEqual({ recovered: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([50, 150]);
    await expect(store.loadDomainConfig(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API)).resolves.toMatchObject({
      requestDelayMs: 200,
      learnedMinDelayMs: 100,
    });
  });

  it("returns provider POST response snapshots after retryable automation recovery", async () => {
    const providerSnapshot = {
      searchId: "src_search_1",
      results: [{ productId: 12345, name: "Furret" }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(providerSnapshot));
    const client = clientWithConfig(
      {
        maxRetries: 1,
      },
      {
        fetch: fetchMock,
        random: () => 0,
      },
    );

    await expect(client.post("/v1/search", { query: "Furret" })).resolves.toEqual(providerSnapshot);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://mp-search-api.tcgplayer.com/v1/search");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ query: "Furret" }),
    });
  });

  it("decreases adaptive delay after a configured success streak", async () => {
    const store = createInMemoryTcgplayerAutomationHttpConfigStore({
      adaptiveConfig: {
        ...DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG,
        successThreshold: 1,
      },
      domainConfigs: domainConfigs({
        requestDelayMs: 500,
        learnedMinDelayMs: 100,
      }),
    });
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI,
      "https://mpapi.tcgplayer.com",
      store,
      {
        fetch: vi.fn(async () => jsonResponse({ ok: true })),
        sleep: async () => undefined,
      },
    );

    await client.get("/catalog");

    await expect(store.loadDomainConfig(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI)).resolves.toMatchObject({
      requestDelayMs: 400,
      learnedMinDelayMs: 100,
    });
  });

  it("returns structured nonretryable provider errors", async () => {
    const client = clientWithConfig(
      { maxRetries: 0 },
      {
        fetch: vi.fn(async () => textResponse("not found", { status: 404 })),
      },
    );

    await expect(client.get("/missing")).rejects.toMatchObject({
      name: "TcgplayerAutomationHttpError",
      status: 404,
      responseBody: "not found",
    } satisfies Partial<TcgplayerAutomationHttpError>);
  });

  it("surfaces sanitized retry exhaustion details for operators", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse('unavailable {"sellerKey":"seller-key"}', { status: 503 }))
      .mockResolvedValueOnce(textResponse('still unavailable {"sellerKey":"seller-key"}', { status: 503 }));
    const client = clientWithConfig(
      {
        maxRetries: 1,
      },
      {
        fetch: fetchMock,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
      },
    );

    await expect(client.get("/unstable")).rejects.toMatchObject({
      name: "TcgplayerAutomationHttpError",
      status: 503,
      responseBody: 'still unavailable {"sellerKey":"<redacted>"}',
    } satisfies Partial<TcgplayerAutomationHttpError>);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([0]);
  });

  it("creates the four Catalog-relevant automation-app domain clients", () => {
    const clients = createTcgplayerAutomationHttpClients(createInMemoryTcgplayerAutomationHttpConfigStore());

    expect(clients.mpSearchApi).toMatchObject({
      domainKey: TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
      baseUrl: "https://mp-search-api.tcgplayer.com",
    });
    expect(clients.mpApi).toMatchObject({
      domainKey: TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI,
      baseUrl: "https://mpapi.tcgplayer.com",
    });
    expect(clients.infiniteApi).toMatchObject({
      domainKey: TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      baseUrl: "https://infinite-api.tcgplayer.com",
    });
    expect(clients.mpGateway).toMatchObject({
      domainKey: TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY,
      baseUrl: "https://mpgateway.tcgplayer.com",
    });
  });

  it("loads and persists learned throttling delays through the Catalog postgres store", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db = {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("SELECT domain_key")) {
          return {
            rows: [
              {
                domain_key: "mpSearchApi",
                request_delay_ms: 750,
                learned_min_delay_ms: 250,
              },
            ] as T[],
          };
        }
        return { rows: [] as T[] };
      },
    } as unknown as PgQueryable;
    const store = createPostgresTcgplayerAutomationHttpConfigStore(db);

    await expect(store.loadDomainConfig(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API)).resolves.toMatchObject({
      requestDelayMs: 750,
      learnedMinDelayMs: 250,
    });
    await store.persistDomainDelays(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI, {
      requestDelayMs: 300,
      learnedMinDelayMs: 100,
    });

    expect(queries.at(-1)).toMatchObject({
      values: [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI, 300, 100],
    });
  });

  it("fails closed when durable config loading is unmigrated and never calls the provider", async () => {
    const fetchMock = vi.fn();
    const failure = Object.assign(new Error("column effective_request_delay_ms does not exist; secret driver detail"), {
      code: "42703",
    });
    const db = {
      query: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as PgQueryable;
    const store = createPostgresTcgplayerAutomationHttpConfigStore(db);
    const client = new TcgplayerAutomationDomainHttpClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
      "https://synthetic-provider.invalid",
      store,
      { fetch: fetchMock },
    );

    await expect(client.get("/blocked")).rejects.toBeInstanceOf(TcgplayerAutomationAuthorityError);
    await expect(client.get("/blocked-again")).rejects.toMatchObject({
      name: "TcgplayerAutomationAuthorityError",
      message: expect.stringMatching(/42703/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret driver detail");
  });

  it("redacts provider diagnostics and caps retained body length", () => {
    const diagnostic = redactTcgplayerAutomationProviderDiagnostic(
      `TCGAuthTicket_Production=secret-cookie; sellerId=123 sellerName=seller ${"x".repeat(2_100)}`,
    );

    expect(diagnostic).toContain("TCGAuthTicket_Production=<redacted>");
    expect(diagnostic).toContain("sellerId=<redacted>");
    expect(diagnostic).toContain("sellerName=<redacted>");
    expect(diagnostic).not.toContain("secret-cookie");
    expect(diagnostic).not.toContain("seller ");
    expect(diagnostic).toMatch(/\.\.\.\[truncated]$/);
  });
});

function clientWithConfig(
  config: Partial<TcgplayerAutomationHttpConfig>,
  deps: ConstructorParameters<typeof TcgplayerAutomationDomainHttpClient>[3],
) {
  return new TcgplayerAutomationDomainHttpClient(
    TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
    "https://mp-search-api.tcgplayer.com",
    createInMemoryTcgplayerAutomationHttpConfigStore(config),
    {
      sleep: async () => undefined,
      ...deps,
    },
  );
}

function domainConfigs(
  overrides: Partial<typeof DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG> = {},
): TcgplayerAutomationHttpConfig["domainConfigs"] {
  return {
    [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API]: {
      ...DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      ...overrides,
    },
    [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI]: {
      ...DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      ...overrides,
    },
    [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API]: {
      ...DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      ...overrides,
    },
    [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY]: {
      ...DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function textResponse(body: string, init: ResponseInit) {
  return new Response(body, init);
}
