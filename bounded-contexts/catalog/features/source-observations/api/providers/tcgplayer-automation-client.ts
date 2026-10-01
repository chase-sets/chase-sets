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
  /** Durable stores expose the shared admission authority. In-memory stores intentionally retain the
   * process-local test double so unit tests cannot accidentally masquerade as cross-process proof. */
  admitDomainRequest?: (
    domainKey: TcgplayerAutomationDomainKey,
    ownerId: string,
    leaseTtlMs: number,
  ) => Promise<TcgplayerAutomationAdmissionResult>;
  renewDomainLease?: (
    domainKey: TcgplayerAutomationDomainKey,
    leaseId: string,
    ownerId: string,
    leaseTtlMs: number,
  ) => Promise<boolean>;
  releaseDomainLease?: (domainKey: TcgplayerAutomationDomainKey, leaseId: string, ownerId: string) => Promise<void>;
  recordDomainRateLimit?: (
    domainKey: TcgplayerAutomationDomainKey,
    adaptiveConfig: TcgplayerAutomationAdaptiveConfig,
    rateLimitCooldownMs?: number,
  ) => Promise<TcgplayerAutomationDomainRateLimitConfig>;
  recordDomainSuccess?: (
    domainKey: TcgplayerAutomationDomainKey,
    adaptiveConfig: TcgplayerAutomationAdaptiveConfig,
    admissionEpoch: number,
  ) => Promise<TcgplayerAutomationDomainRateLimitConfig>;
  readDomainRateLimitState?: () => Promise<readonly TcgplayerAutomationDomainRateLimitState[]>;
}>;

export type TcgplayerAutomationAdmissionResult = Readonly<{
  granted: boolean;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  admittedAt: string;
  notBefore: string;
  epoch: number;
}>;

export type TcgplayerAutomationDomainRateLimitState = Readonly<{
  domainKey: TcgplayerAutomationDomainKey;
  requestDelayMs: number;
  learnedMinDelayMs: number;
  floorRequestDelayMs: number;
  cooldownUntil: string | null;
  liveLeaseCount: number;
  epoch: number;
  snapshotAt: string;
}>;

export type TcgplayerAutomationHttpRequestOptions = Readonly<{
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  responseType?: "json" | "text" | "raw";
  onStage?: (fact: TcgplayerAutomationStageFact) => void;
}>;

export type TcgplayerAutomationStage =
  | "config-wait"
  | "limiter-wait"
  | "throttle-wait"
  | "request-construction"
  | "fetch-start"
  | "headers-received"
  | "error-body-read-start"
  | "error-body-read-end"
  | "parse-start"
  | "parse-end"
  | "parse-failure"
  | "retry-start"
  | "retry-end"
  | "retry-backoff-start"
  | "retry-backoff-end"
  | "cooldown-start"
  | "cooldown-end"
  | "abort"
  | "terminal";

export type TcgplayerAutomationStageFact = Readonly<{
  stage: TcgplayerAutomationStage;
  at: string;
  attempt: number;
  statusClass?: "2xx" | "3xx" | "4xx" | "5xx" | "other";
  httpStatus?: number;
  lastHttpStatus?: number | null;
  lastHttpStatusAttempt?: number | null;
  failureCode?: "credential-unavailable" | null;
  activeStage?: TcgplayerAutomationStage;
  outcome?: "success" | "failure" | "aborted";
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

const CATALOG_REQUEST_DELAY_FLOOR_MS = 200;
const MP_API_REQUEST_DELAY_FLOOR_MS = 10_000;
const CATALOG_COOLDOWN_FLOOR_MS = 10_000;
const MP_SEARCH_API_COOLDOWN_FLOOR_MS = 100_000;
const CATALOG_MAX_CONCURRENT_REQUESTS = 2;
const DURABLE_LEASE_TTL_MS = 60_000;

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

/** Deliberately contains only a stable closed code. Driver messages must never cross this boundary. */
export class TcgplayerAutomationAuthorityError extends Error {
  constructor(code: string) {
    super(`TCGplayer automation admission authority unavailable (${code}).`);
    this.name = "TcgplayerAutomationAuthorityError";
  }
}

function safeAuthorityErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code.replace(/[^A-Z0-9_-]/gi, "").slice(0, 32) || "unknown";
  }
  return "unknown";
}

function createLeaseOwnerId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  return randomUuid ? randomUuid() : `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  private readonly now: () => number;
  private readonly ownerId = createLeaseOwnerId();

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
    this.now = deps.now ?? Date.now;
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
    const { onStage, signal } = input.options;
    let attempt = 1;
    let activeStage: TcgplayerAutomationStage = "config-wait";
    let terminal = false;
    let lastHttpStatus: number | null = null;
    let lastHttpStatusAttempt: number | null = null;
    const emit = (
      stage: TcgplayerAutomationStage,
      detail: Partial<
        Pick<
          TcgplayerAutomationStageFact,
          | "statusClass"
          | "activeStage"
          | "outcome"
          | "httpStatus"
          | "lastHttpStatus"
          | "lastHttpStatusAttempt"
          | "failureCode"
        >
      > = {},
    ) => {
      if (!onStage || (terminal && stage !== "terminal")) return;
      if (stage !== "abort" && stage !== "terminal") activeStage = stage;
      try {
        onStage({ stage, at: new Date(this.now()).toISOString(), attempt, ...detail });
      } catch {
        // Telemetry must not affect requests, including abort and limiter release.
      }
    };
    const finish = (outcome: "success" | "failure" | "aborted", error?: unknown) => {
      if (terminal) return;
      terminal = true;
      emit("terminal", {
        outcome,
        lastHttpStatus,
        lastHttpStatusAttempt,
        failureCode: hasCredentialUnavailableCode(error) ? "credential-unavailable" : null,
      });
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      emit("abort", { activeStage });
      finish("aborted");
    };
    if (onStage) {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }
    emit("config-wait");
    try {
      const initialConfig = await this.configStore.loadConfig();
      if (
        this.configStore.admitDomainRequest &&
        this.configStore.renewDomainLease &&
        this.configStore.releaseDomainLease &&
        this.configStore.recordDomainRateLimit &&
        this.configStore.recordDomainSuccess
      ) {
        return await this.executeWithDurableAuthority(input, initialConfig, emit, finish);
      }
      let recordedRateLimit = false;

      for (let retry = 0; retry <= initialConfig.maxRetries; retry += 1) {
        attempt = retry + 1;
        emit("config-wait");
        const domainConfig = await this.configStore.loadDomainConfig(this.domainKey);
        emit("limiter-wait");
        await this.limiter.acquire(domainConfig.maxConcurrentRequests);

        try {
          emit("throttle-wait");
          await this.throttler.waitToStart(input.options.signal);
          emit("request-construction");
          const url = this.requestUrl(input.path, input.params);
          const headers = await this.requestHeaders(input.options.headers);
          emit("fetch-start");
          const response = await this.fetchImpl(url, {
            method: input.method,
            body: input.body,
            headers,
            signal: input.options.signal,
          });
          const status = response.status;
          const hasValidHttpStatus = Number.isInteger(status) && status >= 100 && status <= 599;
          if (hasValidHttpStatus) {
            lastHttpStatus = status;
            lastHttpStatusAttempt = attempt;
          }
          emit("headers-received", {
            statusClass: httpStatusClass(status),
            ...(hasValidHttpStatus ? { httpStatus: status } : {}),
          });

          if (!response.ok) {
            emit("error-body-read-start");
            const error = await this.httpError(response);
            emit("error-body-read-end");
            throw error;
          }

          await this.throttler.recordSuccess(initialConfig.adaptiveConfig);
          emit("parse-start");
          return parseResponse<TResponse>(response, input.options.responseType ?? "json").then(
            (value) => {
              emit("parse-end");
              finish("success");
              return value;
            },
            (error: unknown) => {
              emit("parse-failure");
              finish("failure");
              throw error;
            },
          );
        } catch (error) {
          if (!isRetryableTcgplayerAutomationError(error) || retry === initialConfig.maxRetries) {
            throw error;
          }

          emit("retry-start");
          if (isTcgplayerAutomationRateLimitError(error)) {
            emit("cooldown-start");
            const updatedConfig = recordedRateLimit
              ? await this.configStore.loadDomainConfig(this.domainKey)
              : await this.throttler.recordRateLimit(initialConfig.adaptiveConfig);
            recordedRateLimit = true;
            await this.throttler.applyRateLimitCooldown(updatedConfig, input.options.signal);
            emit("cooldown-end");
          } else {
            emit("retry-backoff-start");
            await this.sleep(backoffMs(retry, domainConfig.requestDelayMs, this.random), input.options.signal);
            emit("retry-backoff-end");
          }
          emit("retry-end");
        } finally {
          this.limiter.release();
        }
      }

      throw new Error(`Request to ${this.domainKey} failed after ${initialConfig.maxRetries} retries.`);
    } catch (error) {
      finish(signal?.aborted ? "aborted" : "failure", error);
      throw error;
    }
  }

  private async executeWithDurableAuthority<TResponse>(
    input: {
      method: "GET" | "POST";
      path: string;
      params?: Readonly<Record<string, string | number | boolean | null | undefined>>;
      body?: BodyInit;
      options: TcgplayerAutomationHttpRequestOptions;
    },
    initialConfig: TcgplayerAutomationHttpConfig,
    emit: (
      stage: TcgplayerAutomationStage,
      detail?: Partial<Pick<TcgplayerAutomationStageFact, "statusClass" | "activeStage" | "outcome">>,
    ) => void,
    finish: (outcome: "success" | "failure" | "aborted") => void,
  ): Promise<TResponse> {
    const signal = input.options.signal;
    for (let retry = 0; retry <= initialConfig.maxRetries; retry += 1) {
      signal?.throwIfAborted();
      const domainConfig = await this.configStore.loadDomainConfig(this.domainKey);
      emit("limiter-wait");
      const url = this.requestUrl(input.path, input.params);
      const headers = await this.requestHeaders(input.options.headers);
      const admission = await this.waitForDurableAdmission(domainConfig, signal, emit);
      const leaseId = admission.leaseId;
      if (!leaseId) {
        throw new TcgplayerAutomationAuthorityError("admission returned no lease");
      }

      const requestController = new AbortController();
      const renewalController = new AbortController();
      const onAbort = () => requestController.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      let settled = false;
      let renewalError: unknown;
      const renewal = this.renewLeaseUntilSettled(
        leaseId,
        admission.leaseExpiresAt,
        requestController,
        renewalController.signal,
        () => settled,
      ).catch((error: unknown) => {
        renewalError = error;
        requestController.abort(error);
      });

      let response: Response | undefined;
      try {
        emit("request-construction");
        emit("fetch-start");
        response = await this.fetchImpl(url, {
          method: input.method,
          body: input.body,
          headers,
          signal: requestController.signal,
        });
        emit("headers-received", { statusClass: httpStatusClass(response.status) });
        if (!response.ok) {
          emit("error-body-read-start");
          const error = await this.httpError(response);
          emit("error-body-read-end");
          throw error;
        }

        emit("parse-start");
        const value = await parseResponse<TResponse>(response, input.options.responseType ?? "json");
        emit("parse-end");
        if (renewalError) throw renewalError;
        await this.configStore.recordDomainSuccess(this.domainKey, initialConfig.adaptiveConfig, admission.epoch);
        settled = true;
        renewalController.abort();
        await renewal;
        await this.configStore.releaseDomainLease(this.domainKey, leaseId, this.ownerId);
        signal?.removeEventListener("abort", onAbort);
        finish("success");
        return value;
      } catch (error) {
        if (renewalError) error = renewalError;
        settled = true;
        renewalController.abort();
        await renewal.catch(() => undefined);
        await this.configStore.releaseDomainLease(this.domainKey, leaseId, this.ownerId).catch((releaseError) => {
          throw new TcgplayerAutomationAuthorityError(`lease release failed: ${safeAuthorityErrorCode(releaseError)}`);
        });
        signal?.removeEventListener("abort", onAbort);
        if (!isRetryableTcgplayerAutomationError(error) || retry === initialConfig.maxRetries) {
          throw error;
        }

        emit("retry-start");
        if (isTcgplayerAutomationRateLimitError(error)) {
          emit("cooldown-start");
          const updatedConfig = await this.configStore.recordDomainRateLimit(
            this.domainKey,
            initialConfig.adaptiveConfig,
            domainConfig.rateLimitCooldownMs,
          );
          await this.sleep(updatedConfig.rateLimitCooldownMs, signal);
          emit("cooldown-end");
        } else {
          emit("retry-backoff-start");
          await this.sleep(backoffMs(retry, domainConfig.requestDelayMs, this.random), signal);
          emit("retry-backoff-end");
        }
        emit("retry-end");
      }
    }

    throw new Error(`Request to ${this.domainKey} failed after ${initialConfig.maxRetries} retries.`);
  }

  private async waitForDurableAdmission(
    domainConfig: TcgplayerAutomationDomainRateLimitConfig,
    signal: AbortSignal | undefined,
    emit: (stage: TcgplayerAutomationStage) => void,
  ): Promise<TcgplayerAutomationAdmissionResult> {
    const admit = this.configStore.admitDomainRequest;
    if (!admit) throw new TcgplayerAutomationAuthorityError("admission authority unavailable");
    for (;;) {
      signal?.throwIfAborted();
      const result = await admit(this.domainKey, this.ownerId, DURABLE_LEASE_TTL_MS);
      if (result.granted) return result;
      const notBefore = Date.parse(result.notBefore);
      const delay = Math.max(0, notBefore - this.now());
      emit("throttle-wait");
      await this.sleep(delay, signal);
    }
  }

  private async renewLeaseUntilSettled(
    leaseId: string,
    leaseExpiresAt: string | null,
    requestController: AbortController,
    renewalSignal: AbortSignal,
    isSettled: () => boolean,
  ): Promise<void> {
    const renew = this.configStore.renewDomainLease;
    if (!renew || !leaseExpiresAt) throw new TcgplayerAutomationAuthorityError("lease has no expiry");
    const ttl = Math.max(1_000, Date.parse(leaseExpiresAt) - this.now());
    while (!isSettled()) {
      try {
        await this.sleep(Math.max(1_000, Math.floor(ttl / 3)), renewalSignal);
      } catch (error) {
        if (renewalSignal.aborted && isSettled()) return;
        throw error;
      }
      if (isSettled()) return;
      const renewed = await renew(this.domainKey, leaseId, this.ownerId, DURABLE_LEASE_TTL_MS);
      if (!renewed) throw new TcgplayerAutomationAuthorityError("lease renewal rejected");
    }
    void requestController;
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

function hasCredentialUnavailableCode(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "credential-unavailable"
    );
  } catch {
    return false;
  }
}

function httpStatusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" | "other" {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
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
  let config = mergeTcgplayerAutomationHttpConfig(initial, false);

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
  const baseConfig = mergeTcgplayerAutomationHttpConfig(initial, true);

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
           effective_request_delay_ms,
           effective_learned_min_delay_ms,
           updated_at
         ) VALUES ($1, $2, $3, now())
         ON CONFLICT (domain_key) DO UPDATE SET
           effective_request_delay_ms = EXCLUDED.effective_request_delay_ms,
           effective_learned_min_delay_ms = EXCLUDED.effective_learned_min_delay_ms,
           updated_at = EXCLUDED.updated_at`,
        [domainKey, delays.requestDelayMs, delays.learnedMinDelayMs],
      );
    },
    admitDomainRequest: (domainKey, ownerId, leaseTtlMs) =>
      durableQuery(db, async () => {
        const config = baseConfig.domainConfigs[domainKey];
        const result = await db.query<DurableAdmissionRow>(`${DURABLE_ADMISSION_SQL}`, [
          domainKey,
          ownerId,
          `lease-${ownerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          Math.max(30_000, Math.min(120_000, leaseTtlMs)),
          Math.max(CATALOG_REQUEST_DELAY_FLOOR_MS, config.minRequestDelayMs),
          Math.max(CATALOG_REQUEST_DELAY_FLOOR_MS, config.learnedMinDelayMs),
        ]);
        const row = result.rows[0];
        if (!row) throw new TcgplayerAutomationAuthorityError("admission returned no result");
        return {
          granted: row.granted,
          leaseId: row.granted ? row.lease_id : null,
          leaseExpiresAt: row.granted ? row.lease_expires_at : null,
          admittedAt: row.db_now,
          notBefore: row.not_before,
          epoch: Number(row.epoch),
        } satisfies TcgplayerAutomationAdmissionResult;
      }),
    renewDomainLease: (domainKey, leaseId, ownerId, leaseTtlMs) =>
      durableQuery(db, async () => {
        const result = await db.query(
          `UPDATE catalog_tcgplayer_automation_domain_rate_limit_leases
              SET expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond')
            WHERE domain_key = $1 AND lease_id = $2 AND owner_id = $3
              AND expires_at > clock_timestamp()`,
          [domainKey, leaseId, ownerId, Math.max(30_000, Math.min(120_000, leaseTtlMs))],
        );
        return (result.rowCount ?? 0) === 1;
      }),
    releaseDomainLease: (domainKey, leaseId, ownerId) =>
      durableQuery(db, async () => {
        await db.query(
          `DELETE FROM catalog_tcgplayer_automation_domain_rate_limit_leases
            WHERE domain_key = $1 AND lease_id = $2 AND owner_id = $3`,
          [domainKey, leaseId, ownerId],
        );
      }),
    recordDomainRateLimit: (domainKey, adaptiveConfig, rateLimitCooldownMs) =>
      durableQuery(db, async () => {
        const result = await db.query<DurableRateLimitRow>(`${DURABLE_RATE_LIMIT_SQL}`, [
          domainKey,
          adaptiveConfig.increaseMultiplier,
          adaptiveConfig.floorStepMs,
          rateLimitCooldownMs ?? 10_000,
        ]);
        return durableRateLimitConfig(baseConfig, domainKey, result.rows[0]);
      }),
    recordDomainSuccess: (domainKey, adaptiveConfig, admissionEpoch) =>
      durableQuery(db, async () => {
        const result = await db.query<DurableRateLimitRow>(`${DURABLE_SUCCESS_SQL}`, [
          domainKey,
          adaptiveConfig.decreaseAmountMs,
          adaptiveConfig.successThreshold,
          admissionEpoch,
        ]);
        return durableRateLimitConfig(baseConfig, domainKey, result.rows[0]);
      }),
    readDomainRateLimitState: () =>
      durableQuery(db, async () => {
        const result = await db.query<DurableStateRow>(DURABLE_STATE_SQL);
        return result.rows
          .filter((row) => isTcgplayerAutomationDomainKey(row.domain_key))
          .map((row) => ({
            domainKey: row.domain_key,
            requestDelayMs: Number(row.request_delay_ms),
            learnedMinDelayMs: Number(row.learned_min_delay_ms),
            floorRequestDelayMs: Number(row.floor_request_delay_ms),
            cooldownUntil: row.cooldown_until,
            liveLeaseCount: Number(row.live_lease_count),
            epoch: Number(row.epoch),
            snapshotAt: row.snapshot_at,
          }));
      }),
  };
}

export async function readTcgplayerAutomationRateLimitState(
  store: TcgplayerAutomationHttpConfigStore,
): Promise<readonly TcgplayerAutomationDomainRateLimitState[]> {
  if (!store.readDomainRateLimitState) {
    throw new TcgplayerAutomationAuthorityError("state read unavailable");
  }
  return store.readDomainRateLimitState();
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

type DurableAdmissionRow = Readonly<{
  granted: boolean;
  lease_id: string | null;
  lease_expires_at: string | null;
  db_now: string;
  not_before: string;
  epoch: number | string;
}>;

type DurableRateLimitRow = Readonly<{
  domain_key: string;
  effective_request_delay_ms: number;
  effective_learned_min_delay_ms: number;
  epoch: number | string;
}>;

type DurableStateRow = Readonly<{
  domain_key: string;
  request_delay_ms: number;
  learned_min_delay_ms: number;
  floor_request_delay_ms: number;
  cooldown_until: string | null;
  live_lease_count: number;
  epoch: number | string;
  snapshot_at: string;
}>;

const DURABLE_ADMISSION_SQL = `
WITH db_clock AS (SELECT clock_timestamp() AS db_now),
expired AS (
  DELETE FROM catalog_tcgplayer_automation_domain_rate_limit_leases
   WHERE expires_at <= (SELECT db_now FROM db_clock)
),
state AS (
  SELECT r.*,
         GREATEST(
           COALESCE(r.last_request_started_at, '-infinity'::timestamptz) +
             (GREATEST(r.effective_request_delay_ms, $5::integer, $6::integer) * interval '1 millisecond'),
           COALESCE(r.cooldown_until, '-infinity'::timestamptz),
           (SELECT db_now FROM db_clock)
         ) AS not_before,
         (SELECT COUNT(*) FROM catalog_tcgplayer_automation_domain_rate_limit_leases l
           WHERE l.domain_key = r.domain_key AND l.expires_at > (SELECT db_now FROM db_clock)) AS live_count
    FROM catalog_tcgplayer_automation_domain_rate_limits r
   WHERE r.domain_key = $1
   FOR UPDATE
),
booked AS (
  INSERT INTO catalog_tcgplayer_automation_domain_rate_limit_leases
    (lease_id, domain_key, owner_id, acquired_at, expires_at)
  SELECT $3,
         domain_key,
         $2,
         (SELECT db_now FROM db_clock),
         (SELECT db_now FROM db_clock) + ($4::integer * interval '1 millisecond')
    FROM state
   WHERE state.not_before <= (SELECT db_now FROM db_clock)
     AND state.live_count < LEAST(max_concurrent_requests, 2)
  RETURNING lease_id, expires_at
),
marked AS (
  UPDATE catalog_tcgplayer_automation_domain_rate_limits r
     SET last_request_started_at = (SELECT db_now FROM db_clock), updated_at = (SELECT db_now FROM db_clock)
    FROM state
   WHERE r.domain_key = state.domain_key AND EXISTS (SELECT 1 FROM booked)
  RETURNING r.epoch
)
SELECT EXISTS (SELECT 1 FROM booked) AS granted,
       (SELECT lease_id FROM booked) AS lease_id,
       (SELECT expires_at::text FROM booked) AS lease_expires_at,
       (SELECT db_now::text FROM db_clock) AS db_now,
       state.not_before::text AS not_before,
       state.epoch
  FROM state;`;

const DURABLE_RATE_LIMIT_SQL = `
UPDATE catalog_tcgplayer_automation_domain_rate_limits
   SET effective_learned_min_delay_ms = LEAST(
         max_request_delay_ms,
         GREATEST(effective_learned_min_delay_ms, effective_request_delay_ms) + $3::integer
       ),
       effective_request_delay_ms = LEAST(
         max_request_delay_ms,
         GREATEST(
           effective_request_delay_ms,
           (GREATEST(effective_learned_min_delay_ms, effective_request_delay_ms) + $3::integer) * $2::numeric
         )
       ),
       cooldown_until = GREATEST(
         COALESCE(cooldown_until, '-infinity'::timestamptz),
         clock_timestamp() +
           (GREATEST($4::integer, CASE WHEN domain_key = 'mpSearchApi' THEN 100000 ELSE 10000 END)
             * interval '1 millisecond')
       ),
       shared_success_streak = 0,
       epoch = epoch + 1,
       updated_at = clock_timestamp()
 WHERE domain_key = $1
 RETURNING domain_key, effective_request_delay_ms, effective_learned_min_delay_ms, epoch;`;

const DURABLE_SUCCESS_SQL = `
UPDATE catalog_tcgplayer_automation_domain_rate_limits
   SET effective_request_delay_ms = CASE
         WHEN shared_success_streak + 1 >= $3::integer
           THEN GREATEST(min_request_delay_ms, effective_learned_min_delay_ms,
                         effective_request_delay_ms - $2::integer)
         ELSE effective_request_delay_ms
       END,
       shared_success_streak = CASE WHEN shared_success_streak + 1 >= $3::integer THEN 0 ELSE shared_success_streak + 1 END,
       updated_at = clock_timestamp()
 WHERE domain_key = $1 AND epoch = $4
 RETURNING domain_key, effective_request_delay_ms, effective_learned_min_delay_ms, epoch;`;

const DURABLE_STATE_SQL = `
SELECT r.domain_key,
       r.effective_request_delay_ms AS request_delay_ms,
       r.effective_learned_min_delay_ms AS learned_min_delay_ms,
       r.min_request_delay_ms AS floor_request_delay_ms,
       r.cooldown_until::text AS cooldown_until,
       (SELECT COUNT(*) FROM catalog_tcgplayer_automation_domain_rate_limit_leases l
         WHERE l.domain_key = r.domain_key AND l.expires_at > clock_timestamp()) AS live_lease_count,
       r.epoch,
       clock_timestamp()::text AS snapshot_at
  FROM catalog_tcgplayer_automation_domain_rate_limits r
 ORDER BY r.domain_key;`;

async function durableQuery<T>(db: PgQueryable, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new TcgplayerAutomationAuthorityError(safeAuthorityErrorCode(error));
  }
}

function durableRateLimitConfig(
  baseConfig: TcgplayerAutomationHttpConfig,
  domainKey: TcgplayerAutomationDomainKey,
  row: DurableRateLimitRow | undefined,
): TcgplayerAutomationDomainRateLimitConfig {
  if (!row) throw new TcgplayerAutomationAuthorityError("state row missing");
  return {
    ...baseConfig.domainConfigs[domainKey],
    requestDelayMs: Number(row.effective_request_delay_ms),
    learnedMinDelayMs: Number(row.effective_learned_min_delay_ms),
  };
}

function mergeTcgplayerAutomationHttpConfig(
  initial: Partial<TcgplayerAutomationHttpConfig>,
  enforceSafetyFloors = true,
): TcgplayerAutomationHttpConfig {
  const domain = (domainKey: TcgplayerAutomationDomainKey) =>
    enforceSafetyFloors
      ? normalizeDomainConfig(
          domainKey,
          initial.domainConfigs?.[domainKey] ?? DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG,
        )
      : { ...(initial.domainConfigs?.[domainKey] ?? DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG) };
  return {
    auth: {
      tcgAuthCookie: initial.auth?.tcgAuthCookie ?? null,
      userAgent: initial.auth?.userAgent ?? DEFAULT_USER_AGENT,
    },
    domainConfigs: {
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API]: domain(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API),
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI]: domain(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI),
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API]: domain(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.INFINITE_API),
      [TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY]: domain(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_GATEWAY),
    },
    adaptiveConfig: initial.adaptiveConfig ?? DEFAULT_TCGPLAYER_AUTOMATION_ADAPTIVE_CONFIG,
    maxRetries: initial.maxRetries ?? 3,
  };
}

function normalizeDomainConfig(
  domainKey: TcgplayerAutomationDomainKey,
  input: TcgplayerAutomationDomainRateLimitConfig,
): TcgplayerAutomationDomainRateLimitConfig {
  const requestFloor =
    domainKey === TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MPAPI
      ? MP_API_REQUEST_DELAY_FLOOR_MS
      : CATALOG_REQUEST_DELAY_FLOOR_MS;
  const cooldownFloor =
    domainKey === TCGPLAYER_AUTOMATION_DOMAIN_KEYS.MP_SEARCH_API
      ? MP_SEARCH_API_COOLDOWN_FLOOR_MS
      : CATALOG_COOLDOWN_FLOOR_MS;
  if (input.maxRequestDelayMs < requestFloor) {
    throw new Error(`TCGplayer automation ${domainKey} maximum delay is below its safety floor.`);
  }
  const maxRequestDelayMs = input.maxRequestDelayMs;
  const minRequestDelayMs = Math.max(input.minRequestDelayMs, requestFloor);
  const learnedMinDelayMs = Math.max(input.learnedMinDelayMs, minRequestDelayMs);
  const requestDelayMs = Math.max(input.requestDelayMs, learnedMinDelayMs, minRequestDelayMs);
  return {
    ...input,
    requestDelayMs: Math.min(requestDelayMs, maxRequestDelayMs),
    rateLimitCooldownMs: Math.max(input.rateLimitCooldownMs, cooldownFloor),
    maxConcurrentRequests: Math.min(
      Math.max(1, Math.floor(input.maxConcurrentRequests)),
      CATALOG_MAX_CONCURRENT_REQUESTS,
    ),
    minRequestDelayMs,
    maxRequestDelayMs,
    learnedMinDelayMs: Math.min(learnedMinDelayMs, maxRequestDelayMs),
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
    `SELECT domain_key,
            effective_request_delay_ms AS request_delay_ms,
            effective_learned_min_delay_ms AS learned_min_delay_ms
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
                requestDelayMs: Math.max(domainConfig.requestDelayMs, persistedDelays.request_delay_ms),
                learnedMinDelayMs: Math.max(domainConfig.learnedMinDelayMs, persistedDelays.learned_min_delay_ms),
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
  private readonly startQueue: Array<{
    signal?: AbortSignal;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
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
    signal?.throwIfAborted();
    const now = this.deps.now();
    if (this.rateLimitedUntil > now) {
      await this.deps.sleep(this.rateLimitedUntil - now, signal);
    }

    await new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error: unknown) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.startQueue.indexOf(entry);
        if (index >= 0) this.startQueue.splice(index, 1);
        entry.reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.startQueue.push(entry);
      void this.processQueue();
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

  private async processQueue(): Promise<void> {
    if (this.processingQueue) {
      return;
    }

    this.processingQueue = true;
    try {
      for (let entry = this.startQueue.shift(); entry; entry = this.startQueue.shift()) {
        try {
          entry.signal?.throwIfAborted();
          const config = await this.configStore.loadDomainConfig(this.domainKey);
          entry.signal?.throwIfAborted();
          const remainingDelay = config.requestDelayMs - (this.deps.now() - this.lastRequestStartTime);
          if (remainingDelay > 0) {
            await this.deps.sleep(remainingDelay, entry.signal);
          }
          entry.signal?.throwIfAborted();
          this.lastRequestStartTime = this.deps.now();
          entry.resolve();
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.processingQueue = false;
    }
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
  signal?.throwIfAborted();
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
import type { PgQueryable } from "@chase-sets/event-core-postgres";
