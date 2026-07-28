import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  createPostgresTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationHttpClients,
  DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG,
  DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
  TCGPLAYER_AUTOMATION_DOMAIN_KEYS,
  TcgplayerAutomationDomainHttpClient,
  TcgplayerAutomationHttpError,
  redactTcgplayerAutomationProviderDiagnostic,
  type TcgplayerAutomationHttpConfig,
} from "./tcgplayer-automation-client";

describe("TCGplayer automation HTTP client", () => {
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
