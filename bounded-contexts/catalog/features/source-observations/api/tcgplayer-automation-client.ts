export const TCGPLAYER_AUTOMATION_DOMAIN_KEYS = {
  MP_SEARCH_API: "mpSearchApi",
  MPAPI: "mpApi",
  INFINITE_API: "infiniteApi",
  MP_GATEWAY: "mpGateway",
} as const;

export type TcgplayerAutomationDomainKey =
  (typeof TCGPLAYER_AUTOMATION_DOMAIN_KEYS)[keyof typeof TCGPLAYER_AUTOMATION_DOMAIN_KEYS];

export const TCGPLAYER_AUTOMATION_DOMAINS: Record<TcgplayerAutomationDomainKey, string> = {
  [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API]: "mp-search-api.tcgplayer.com",
  [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI]: "mpapi.tcgplayer.com",
  [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API]: "infinite-api.tcgplayer.com",
  [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY]: "mpgateway.tcgplayer.com",
};

export const TCGPLAYER_AUTOMATION_RETRYABLE_STATUS_CODES = [403, 429, 502, 503, 504] as const;

export type TcgplayerAutomationDomainRateLimitConfig = Readonly<{
  requestDelayMs: number;
  rateLimitCooldownMs: number;
  maxConcurrentRequests: number;
  adaptiveEnabled: boolean;
  minRequestDelayMs: number;
  maxRequestDelayMs: number;
  learnedMinDelayMs: number;
}>;

export type TcgplayerAutomationAdaptiveConfig = Readonly<{
  increaseMultiplier: number;
  floorStepMs: number;
  decreaseAmountMs: number;
  successThreshold: number;
}>;

export type TcgplayerAutomationAuthConfig = Readonly<{
  tcgAuthCookie: string | null;
  userAgent: string;
}>;

export type TcgplayerAutomationHttpConfig = Readonly<{
  auth: TcgplayerAutomationAuthConfig;
  domainConfigs: Readonly<Record<TcgplayerAutomationDomainKey, TcgplayerAutomationDomainRateLimitConfig>>;
  adaptiveConfig: TcgplayerAutomationAdaptiveConfig;
  maxRetries: number;
}>;

export type TcgplayerAutomationHttpConfigStore = Readonly<{
  loadConfig: () => Promise<TcgplayerAutomationHttpConfig>;
  loadDomainConfig: (domainKey: TcgplayerAutomationDomainKey) => Promise<TcgplayerAutomationDomainRateLimitConfig>;
  persistDomainDelays: (
    domainKey: TcgplayerAutomationDomainKey,
    delays: Readonly<{ requestDelayMs: number; learnedMinDelayMs: number }>,
  ) => Promise<void>;
}>;

export type TcgplayerAutomationHttpRequestOptions = Readonly<{
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  responseType?: "json" | "text" | "raw";
}>;

export type TcgplayerAutomationHttpClientDeps = Readonly<{
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}>;

export type TcgplayerAutomationHttpClients = Readonly<{
  mpSearchApi: TcgplayerAutomationDomainHttpClient;
  mpApi: TcgplayerAutomationDomainHttpClient;
  infiniteApi: TcgplayerAutomationDomainHttpClient;
  mpGateway: TcgplayerAutomationDomainHttpClient;
}>;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export const DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG: TcgplayerAutomationDomainRateLimitConfig = {
  requestDelayMs: 0,
  rateLimitCooldownMs: 10_000,
  maxConcurrentRequests: 5,
  adaptiveEnabled: true,
  minRequestDelayMs: 0,
  maxRequestDelayMs: 10_000,
  learnedMinDelayMs: 0,
};

export const DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG: TcgplayerAutomationAdaptiveConfig = {
  increaseMultiplier: 2,
  floorStepMs: 100,
  decreaseAmountMs: 100,
  successThreshold: 10,
};

const MAX_PROVIDER_DIAGNOSTIC_BODY_LENGTH = 2_048;

export class TcgplayerAutomationHttpError extends Error {
  public readonly status: number;
  public readonly responseBody: string | null;

  constructor(message: string, status: number, responseBody: string | null) {
    super(message);
    this.name = "TcgplayerAutomationHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class TcgplayerAutomationDomainHttpClient {
  public readonly domainKey: TcgplayerAutomationDomainKey;
  public readonly baseUrl: string;
  private readonly configStore: TcgplayerAutomationHttpConfigStore;
  private readonly throttler: TcgplayerAutomationRequestThrottler;
  private readonly limiter = new TcgplayerAutomationConcurrencyLimiter();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(
    domainKey: TcgplayerAutomationDomainKey,
    baseUrl: string,
    configStore: TcgplayerAutomationHttpConfigStore,
    deps: TcgplayerAutomationHttpClientDeps = {},
  ) {
    this.domainKey = domainKey;
    this.baseUrl = baseUrl;
    this.configStore = configStore;
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? sleepWithAbort;
    this.random = deps.random ?? Math.random;
    this.throttler = new TcgplayerAutomationRequestThrottler(domainKey, configStore, {
      sleep: this.sleep,
      now: deps.now ?? Date.now,
    });
  }

  async get<TResponse>(
    path: string,
    params: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
    options: TcgplayerAutomationHttpRequestOptions = {},
  ): Promise<TResponse> {
    return this.executeWithRetry<TResponse>({
      method: "GET",
      path,
      params,
      options,
    });
  }

  async post<TResponse>(
    path: string,
    data: unknown = undefined,
    options: TcgplayerAutomationHttpRequestOptions = {},
  ): Promise<TResponse> {
    return this.executeWithRetry<TResponse>({
      method: "POST",
      path,
      body: data === undefined ? undefined : JSON.stringify(data),
      options,
    });
  }

  private async executeWithRetry<TResponse>(input: {
    method: "GET" | "POST";
    path: string;
    params?: Readonly<Record<string, string | number | boolean | null | undefined>>;
    body?: BodyInit;
    options: TcgplayerAutomationHttpRequestOptions;
  }): Promise<TResponse> {
    const initialConfig = await this.configStore.loadConfig();
    let recordedRateLimit = false;

    for (let attempt = 0; attempt <= initialConfig.maxRetries; attempt += 1) {
      const domainConfig = await this.configStore.loadDomainConfig(this.domainKey);
      await this.limiter.acquire(domainConfig.maxConcurrentRequests);

      try {
        await this.throttler.waitToStart(input.options.signal);
        const response = await this.fetchImpl(this.requestUrl(input.path, input.params), {
          method: input.method,
          body: input.body,
          headers: await this.requestHeaders(input.options.headers),
          signal: input.options.signal,
        });

        if (!response.ok) {
          throw await this.httpError(response);
        }

        await this.throttler.recordSuccess(initialConfig.adaptiveConfig);
        return parseResponse<TResponse>(response, input.options.responseType ?? "json");
      } catch (error) {
        if (!isRetryableTcgplayerAutomationError(error) || attempt === initialConfig.maxRetries) {
          throw error;
        }

        if (isTcgplayerAutomationRateLimitError(error)) {
          const updatedConfig = recordedRateLimit
            ? await this.configStore.loadDomainConfig(this.domainKey)
            : await this.throttler.recordRateLimit(initialConfig.adaptiveConfig);
          recordedRateLimit = true;
          await this.throttler.applyRateLimitCooldown(updatedConfig, input.options.signal);
        } else {
          await this.sleep(backoffMs(attempt, domainConfig.requestDelayMs, this.random), input.options.signal);
        }
      } finally {
        this.limiter.release();
      }
    }

    throw new Error(`Request to ${this.domainKey} failed after ${initialConfig.maxRetries} retries.`);
  }

  private requestUrl(
    path: string,
    params: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined,
  ): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async requestHeaders(extraHeaders: Readonly<Record<string, string>> | undefined): Promise<Headers> {
    const config = await this.configStore.loadConfig();
    const headers = new Headers({
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "User-Agent": config.auth.userAgent,
      ...extraHeaders,
    });

    if (config.auth.tcgAuthCookie?.trim()) {
      headers.set("Cookie", `TCGAuthTicket_Production=${config.auth.tcgAuthCookie.trim()};`);
    }

    return headers;
  }

  private async httpError(response: Response): Promise<TcgplayerAutomationHttpError> {
    const responseBody = await response.text().catch(() => null);
    return new TcgplayerAutomationHttpError(
      `TCGplayer automation request to ${this.domainKey} failed with HTTP ${response.status}.`,
      response.status,
      redactTcgplayerAutomationProviderDiagnostic(responseBody),
    );
  }
}

export function createTcgplayerAutomationHttpClients(
  configStore: TcgplayerAutomationHttpConfigStore,
  deps: TcgplayerAutomationHttpClientDeps = {},
): TcgplayerAutomationHttpClients {
  return {
    mpSearchApi: createTcgplayerAutomationDomainClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API,
      configStore,
      deps,
    ),
    mpApi: createTcgplayerAutomationDomainClient(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI, configStore, deps),
    infiniteApi: createTcgplayerAutomationDomainClient(
      TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API,
      configStore,
      deps,
    ),
    mpGateway: createTcgplayerAutomationDomainClient(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY, configStore, deps),
  };
}

export function createInMemoryTcgplayerAutomationHttpConfigStore(
  initial: Partial<TcgplayerAutomationHttpConfig> = {},
): TcgplayerAutomationHttpConfigStore {
  let config = mergeTcgplayerAutomationHttpConfig(initial);

  return {
    loadConfig: async () => config,
    loadDomainConfig: async (domainKey) => config.domainConfigs[domainKey],
    persistDomainDelays: async (domainKey, delays) => {
      config = {
        ...config,
        domainConfigs: {
          ...config.domainConfigs,
          [domainKey]: {
            ...config.domainConfigs[domainKey],
            requestDelayMs: delays.requestDelayMs,
            learnedMinDelayMs: delays.learnedMinDelayMs,
          },
        },
      };
    },
  };
}

export function createPostgresTcgplayerAutomationHttpConfigStore(
  db: PgQueryable,
  initial: Partial<TcgplayerAutomationHttpConfig> = {},
): TcgplayerAutomationHttpConfigStore {
  const baseConfig = mergeTcgplayerAutomationHttpConfig(initial);

  return {
    loadConfig: async () => applyPersistedDomainDelays(baseConfig, await loadPersistedDomainDelays(db)),
    loadDomainConfig: async (domainKey) => {
      const config = applyPersistedDomainDelays(baseConfig, await loadPersistedDomainDelays(db));
      return config.domainConfigs[domainKey];
    },
    persistDomainDelays: async (domainKey, delays) => {
      await db.query(
        `INSERT INTO catalog_tcgplayer_automation_domain_rate_limits (
           domain_key,
           request_delay_ms,
           learned_min_delay_ms,
           updated_at
         ) VALUES ($1, $2, $3, now())
         ON CONFLICT (domain_key) DO UPDATE SET
           request_delay_ms = EXCLUDED.request_delay_ms,
           learned_min_delay_ms = EXCLUDED.learned_min_delay_ms,
           updated_at = EXCLUDED.updated_at`,
        [domainKey, delays.requestDelayMs, delays.learnedMinDelayMs],
      );
    },
  };
}

function createTcgplayerAutomationDomainClient(
  domainKey: TcgplayerAutomationDomainKey,
  configStore: TcgplayerAutomationHttpConfigStore,
  deps: TcgplayerAutomationHttpClientDeps,
) {
  return new TcgplayerAutomationDomainHttpClient(
    domainKey,
    `https://${TCGPLAYER_AUTOMATION_DOMAINS[domainKey]}`,
    configStore,
    deps,
  );
}

function mergeTcgplayerAutomationHttpConfig(
  initial: Partial<TcgplayerAutomationHttpConfig>,
): TcgplayerAutomationHttpConfig {
  return {
    auth: {
      tcgAuthCookie: initial.auth?.tcgAuthCookie ?? null,
      userAgent: initial.auth?.userAgent ?? DEFAULT_USER_AGENT,
    },
    domainConfigs: {
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API]:
        initial.domainConfigs?.mpSearchApi ?? DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI]:
        initial.domainConfigs?.mpApi ?? DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API]:
        initial.domainConfigs?.infiniteApi ?? DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY]:
        initial.domainConfigs?.mpGateway ?? DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
    },
    adaptiveConfig: initial.adaptiveConfig ?? DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG,
    maxRetries: initial.maxRetries ?? 3,
  };
}

type PersistedDomainDelayRow = Readonly<{
  domain_key: string;
  request_delay_ms: number;
  learned_min_delay_ms: number;
}>;

async function loadPersistedDomainDelays(
  db: PgQueryable,
): Promise<ReadonlyMap<TcgplayerAutomationDomainKey, PersistedDomainDelayRow>> {
  const result = await db.query<PersistedDomainDelayRow>(
    `SELECT domain_key, request_delay_ms, learned_min_delay_ms
     FROM catalog_tcgplayer_automation_domain_rate_limits`,
  );
  return new Map(
    result.rows
      .filter((row): row is PersistedDomainDelayRow & { domain_key: TcgplayerAutomationDomainKey } =>
        isTcgplayerAutomationDomainKey(row.domain_key),
      )
      .map((row) => [row.domain_key, row]),
  );
}

function applyPersistedDomainDelays(
  config: TcgplayerAutomationHttpConfig,
  persisted: ReadonlyMap<TcgplayerAutomationDomainKey, PersistedDomainDelayRow>,
): TcgplayerAutomationHttpConfig {
  return {
    ...config,
    domainConfigs: Object.fromEntries(
      Object.entries(config.domainConfigs).map(([domainKey, domainConfig]) => {
        const persistedDelays = persisted.get(domainKey as TcgplayerAutomationDomainKey);
        return [
          domainKey,
          persistedDelays
            ? {
                ...domainConfig,
                requestDelayMs: persistedDelays.request_delay_ms,
                learnedMinDelayMs: persistedDelays.learned_min_delay_ms,
              }
            : domainConfig,
        ];
      }),
    ) as TcgplayerAutomationHttpConfig["domainConfigs"],
  };
}

function isTcgplayerAutomationDomainKey(value: string): value is TcgplayerAutomationDomainKey {
  return Object.values(TCGPLAYER_AUTOMATION_DOMAIN_KEYS).includes(value as TcgplayerAutomationDomainKey);
}

export function redactTcgplayerAutomationProviderDiagnostic(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const redacted = value
    .replace(/TCGAuthTicket_Production\s*=\s*[^;\s"']+/gi, "TCGAuthTicket_Production=<redacted>")
    .replace(
      /("(?:authorization|cookie|sellerId|sellerKey|sellerName|sellerEmail|email|phone)"\s*:\s*)"[^"]*"/gi,
      '$1"<redacted>"',
    )
    .replace(/("(?:sellerId|sellerKey)"\s*:\s*)\d+/gi, '$1"<redacted>"')
    .replace(
      /((?:authorization|cookie|sellerId|sellerKey|sellerName|sellerEmail|email|phone)\s*=\s*)[^&\s;]+/gi,
      "$1<redacted>",
    );

  return redacted.length > MAX_PROVIDER_DIAGNOSTIC_BODY_LENGTH
    ? `${redacted.slice(0, MAX_PROVIDER_DIAGNOSTIC_BODY_LENGTH)}...[truncated]`
    : redacted;
}

class TcgplayerAutomationRequestThrottler {
  private readonly domainKey: TcgplayerAutomationDomainKey;
  private readonly configStore: TcgplayerAutomationHttpConfigStore;
  private readonly deps: TcgplayerAutomationRequestThrottlerDeps;
  private lastRequestStartTime = 0;
  private rateLimitedUntil = 0;
  private readonly startQueue: Array<() => void> = [];
  private processingQueue = false;
  private consecutiveSuccesses = 0;

  constructor(
    domainKey: TcgplayerAutomationDomainKey,
    configStore: TcgplayerAutomationHttpConfigStore,
    deps: TcgplayerAutomationRequestThrottlerDeps,
  ) {
    this.domainKey = domainKey;
    this.configStore = configStore;
    this.deps = deps;
  }

  async waitToStart(signal?: AbortSignal): Promise<void> {
    const now = this.deps.now();
    if (this.rateLimitedUntil > now) {
      await this.deps.sleep(this.rateLimitedUntil - now, signal);
    }

    await new Promise<void>((resolve) => {
      this.startQueue.push(resolve);
      void this.processQueue(signal);
    });
  }

  async recordSuccess(adaptiveConfig: TcgplayerAutomationAdaptiveConfig): Promise<void> {
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses < adaptiveConfig.successThreshold) {
      return;
    }

    this.consecutiveSuccesses = 0;
    const config = await this.configStore.loadDomainConfig(this.domainKey);
    if (!config.adaptiveEnabled) {
      return;
    }

    const effectiveFloor = Math.max(config.minRequestDelayMs, config.learnedMinDelayMs);
    const requestDelayMs = Math.max(effectiveFloor, config.requestDelayMs - adaptiveConfig.decreaseAmountMs);
    if (requestDelayMs < config.requestDelayMs) {
      await this.configStore.persistDomainDelays(this.domainKey, {
        requestDelayMs,
        learnedMinDelayMs: config.learnedMinDelayMs,
      });
    }
  }

  async recordRateLimit(
    adaptiveConfig: TcgplayerAutomationAdaptiveConfig,
  ): Promise<TcgplayerAutomationDomainRateLimitConfig> {
    const config = await this.configStore.loadDomainConfig(this.domainKey);
    if (!config.adaptiveEnabled) {
      return config;
    }

    this.consecutiveSuccesses = 0;
    const learnedMinDelayMs = Math.min(config.maxRequestDelayMs, config.requestDelayMs + adaptiveConfig.floorStepMs);
    const requestDelayMs = Math.min(config.maxRequestDelayMs, learnedMinDelayMs * adaptiveConfig.increaseMultiplier);
    await this.configStore.persistDomainDelays(this.domainKey, { requestDelayMs, learnedMinDelayMs });

    return {
      ...config,
      requestDelayMs,
      learnedMinDelayMs,
    };
  }

  async applyRateLimitCooldown(config: TcgplayerAutomationDomainRateLimitConfig, signal?: AbortSignal): Promise<void> {
    this.rateLimitedUntil = this.deps.now() + config.rateLimitCooldownMs;
    await this.deps.sleep(config.rateLimitCooldownMs, signal);
  }

  private async processQueue(signal?: AbortSignal): Promise<void> {
    if (this.processingQueue) {
      return;
    }

    this.processingQueue = true;
    while (this.startQueue.length > 0) {
      const config = await this.configStore.loadDomainConfig(this.domainKey);
      const remainingDelay = config.requestDelayMs - (this.deps.now() - this.lastRequestStartTime);
      if (remainingDelay > 0) {
        await this.deps.sleep(remainingDelay, signal);
      }

      this.lastRequestStartTime = this.deps.now();
      this.startQueue.shift()?.();
    }
    this.processingQueue = false;
  }
}

type TcgplayerAutomationRequestThrottlerDeps = Readonly<{
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}>;

class TcgplayerAutomationConcurrencyLimiter {
  private activeRequests = 0;
  private readonly queue: Array<() => void> = [];

  async acquire(maxConcurrentRequests: number): Promise<void> {
    if (this.activeRequests < maxConcurrentRequests) {
      this.activeRequests += 1;
      return;
    }

    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.activeRequests += 1;
  }

  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.queue.shift()?.();
  }
}

async function parseResponse<TResponse>(
  response: Response,
  responseType: NonNullable<TcgplayerAutomationHttpRequestOptions["responseType"]>,
): Promise<TResponse> {
  if (responseType === "raw") {
    return response as TResponse;
  }

  if (responseType === "text") {
    return (await response.text()) as TResponse;
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return (await response.json()) as TResponse;
}

function isRetryableTcgplayerAutomationError(error: unknown): error is TcgplayerAutomationHttpError {
  return (
    error instanceof TcgplayerAutomationHttpError &&
    TCGPLAYER_AUTOMATION_RETRYABLE_STATUS_CODES.includes(
      error.status as (typeof TCGPLAYER_AUTOMATION_RETRYABLE_STATUS_CODES)[number],
    )
  );
}

function isTcgplayerAutomationRateLimitError(error: unknown): error is TcgplayerAutomationHttpError {
  return error instanceof TcgplayerAutomationHttpError && (error.status === 403 || error.status === 429);
}

function backoffMs(attempt: number, baseDelayMs: number, random: () => number): number {
  return baseDelayMs * 2 ** attempt + random() * 1000;
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}
import type { PgQueryable } from "@chase-sets/event-core-postgres";
