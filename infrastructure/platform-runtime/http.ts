import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  COOKIE_BACKED_CONTINUATION_RELOAD_HEADER,
  appendCompactPostWriteToken,
  createPostWriteTokenPayloadFromSources,
  encodeFreshWriteReceipt,
  loadAfterWrite as loadAfterWriteWithContract,
  materializePostWriteTokenPayload,
  navigateAfterWrite as navigateAfterWriteWithContract,
  navigateAfterWriteFromSources as navigateAfterWriteFromSourcesWithContract,
  readCompactPostWriteToken,
  readFreshWriteToken,
  redirectAfterWriteFromSources as redirectAfterWriteFromSourcesWithContract,
  type FreshWriteReadErrorClassification,
  type LoadAfterWriteOptions,
  type LoadAfterWriteResult,
  type NavigateAfterWriteOptions,
  type PostWriteTokenResolver,
  type PostWriteTokenStore,
  type RedirectAfterWriteOptions,
} from "@chase-sets/http/responses";
import {
  recordPlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyOutcome,
} from "./post-write-consistency";

export const PLATFORM_INTERNAL_AUTH_HEADER = "x-chase-sets-internal-auth";
export const PLATFORM_INTERNAL_AUTH_SECRET_ENV = "PLATFORM_INTERNAL_AUTH_SECRET";
export const CHASE_SETS_INTERNAL_API_ORIGIN_ENV = "CHASE_SETS_INTERNAL_API_ORIGIN";
export const CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV = "CHASE_SETS_TRUST_FORWARDED_HEADERS";
const DEFAULT_DEV_INTERNAL_AUTH_SECRET = "dev-platform-internal-auth-secret";
const DEFAULT_POST_WRITE_TOKEN_TTL_MS = 120_000;

export class UnresolvedPostWriteTokenError extends Error {
  readonly code = "post_write_token_unresolved";

  constructor() {
    super("Compact post-write token could not be resolved.");
    this.name = "UnresolvedPostWriteTokenError";
  }
}

export class MissingInternalApiOriginError extends Error {
  constructor() {
    super(
      `${CHASE_SETS_INTERNAL_API_ORIGIN_ENV} must be configured before forwarding browser credentials to an internal API.`,
    );
    this.name = "MissingInternalApiOriginError";
  }
}

export type PlatformPostWriteTelemetry = Readonly<
  Omit<PlatformPostWriteConsistencyEvent, "outcome" | "strategy"> & {
    strategy?: string;
  }
>;

export type PlatformNavigateAfterWriteOptions = NavigateAfterWriteOptions &
  Readonly<{
    telemetry?: PlatformPostWriteTelemetry;
  }>;

export type PlatformRedirectAfterWriteOptions = RedirectAfterWriteOptions &
  Readonly<{
    telemetry?: PlatformPostWriteTelemetry;
  }>;

export type PlatformCompactPostWriteTokenOptions = NavigateAfterWriteOptions &
  Readonly<{
    postWriteTokenStore: PostWriteTokenStore;
    postWriteTokenTtlMs?: number;
    telemetry?: PlatformPostWriteTelemetry;
  }>;

export type PlatformCompactRedirectAfterWriteOptions = RedirectAfterWriteOptions &
  Readonly<{
    postWriteTokenStore: PostWriteTokenStore;
    postWriteTokenTtlMs?: number;
    telemetry?: PlatformPostWriteTelemetry;
  }>;

export type PlatformLoadAfterWriteOptions<T> = LoadAfterWriteOptions<T> &
  Readonly<{
    postWriteTokenResolver?: PostWriteTokenResolver;
    telemetry?: PlatformPostWriteTelemetry;
  }>;

export type PlatformForwardedAuthHeadersOptions = Readonly<{
  readTargetContextName?: string;
  postWriteTokenResolver?: PostWriteTokenResolver;
  nowMs?: number;
  maxAgeMs?: number;
  trustForwardedHeaders?: boolean;
}>;

export type PlatformRequestOriginOptions = Readonly<{
  trustForwardedHeaders?: boolean;
}>;

export type PlatformRequestApiBaseUrlOptions = PlatformRequestOriginOptions &
  Readonly<{
    requireInternalApiOrigin?: boolean;
  }>;

export type OffsetPageParams = Readonly<{
  limit: number;
  offset: number;
  query: string;
}>;

export type ReadOffsetPageParamsOptions = Readonly<{
  defaultLimit?: number;
  maxLimit?: number;
}>;

const DEFAULT_OFFSET_PAGE_LIMIT = 50;
const DEFAULT_MAX_OFFSET_PAGE_LIMIT = 500;

function positiveIntegerFromSearchParam(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeIntegerFromSearchParam(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readOffsetPageParams(
  requestOrUrl: Request | string | URL,
  options: ReadOffsetPageParamsOptions = {},
): OffsetPageParams {
  const url =
    requestOrUrl instanceof URL
      ? requestOrUrl
      : new URL(typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url, "https://chase-sets.local");
  const defaultLimit = options.defaultLimit ?? DEFAULT_OFFSET_PAGE_LIMIT;
  const maxLimit = options.maxLimit ?? DEFAULT_MAX_OFFSET_PAGE_LIMIT;
  const limit = Math.min(positiveIntegerFromSearchParam(url.searchParams.get("limit"), defaultLimit), maxLimit);
  const offset = nonNegativeIntegerFromSearchParam(url.searchParams.get("offset"), 0);
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  }).toString();

  return { limit, offset, query };
}

function recordPostWriteTelemetry(
  telemetry: PlatformPostWriteTelemetry | undefined,
  outcome: PlatformPostWriteConsistencyOutcome,
  extra: Partial<PlatformPostWriteConsistencyEvent> = {},
) {
  if (!telemetry) {
    return;
  }

  const { strategy = "fresh-read", ...base } = telemetry;
  recordPlatformPostWriteConsistencyEvent({
    ...base,
    ...extra,
    strategy,
    outcome,
  });
}

function postWriteReadOutcome<T>(result: LoadAfterWriteResult<T>): PlatformPostWriteConsistencyOutcome {
  if (result.kind === "data") {
    return "read_data";
  }

  return result.kind === "pending" ? "read_pending" : "read_permanent";
}

function unresolvedPostWriteTokenClassification(): FreshWriteReadErrorClassification {
  return {
    kind: "not-fresh-write",
    transient: false,
    receipt: null,
    status: null,
    errorCode: "post_write_token_unresolved",
  };
}

function unresolvedPostWriteTokenResult<T>(error: UnresolvedPostWriteTokenError): LoadAfterWriteResult<T> {
  return {
    kind: "permanent-failure",
    reason: "fresh-write-read-permanent",
    recoveryKind: "terminal-failure",
    classification: unresolvedPostWriteTokenClassification(),
    error,
  };
}

export async function resolvePostWriteTokenRequest(
  request: Request,
  resolver: PostWriteTokenResolver | undefined,
): Promise<Request> {
  if (!resolver) {
    return request;
  }

  const token = readCompactPostWriteToken(request);
  if (!token) {
    return request;
  }

  const payload = await resolver.resolvePostWriteToken(token);
  if (!payload) {
    throw new UnresolvedPostWriteTokenError();
  }

  return new Request(materializePostWriteTokenPayload(request.url, payload), request);
}

export function resolvePlatformInternalAuthSecret(
  options: Readonly<{
    requireExplicitInProduction?: boolean;
    productionLike?: boolean;
    productionMissingSecretError?: string;
  }> = {},
) {
  const configured = process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV]?.trim();
  const productionLike = options.productionLike ?? process.env.NODE_ENV === "production";
  if (options.requireExplicitInProduction && productionLike && !configured) {
    throw new Error(
      options.productionMissingSecretError ??
        `${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API calls in production.`,
    );
  }

  return configured || DEFAULT_DEV_INTERNAL_AUTH_SECRET;
}

export function navigateAfterWrite(
  commandResult: unknown,
  destinationRoute: string,
  options: PlatformNavigateAfterWriteOptions = {},
): string {
  const destination = navigateAfterWriteWithContract(commandResult, destinationRoute, options);
  recordPostWriteTelemetry(
    options.telemetry,
    readFreshWriteToken(destination, options.nowMs) ? "navigation_encoded" : "navigation_missing_receipt",
    options.handoff ? { correctionSource: `semantic-handoff:${options.handoff.kind}` } : {},
  );
  return destination;
}

export function navigateAfterWriteFromSources(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: PlatformNavigateAfterWriteOptions = {},
): string {
  const destination = navigateAfterWriteFromSourcesWithContract(commandResults, destinationRoute, options);
  recordPostWriteTelemetry(
    options.telemetry,
    readFreshWriteToken(destination, options.nowMs) ? "navigation_encoded" : "navigation_missing_receipt",
    options.handoff ? { correctionSource: `semantic-handoff:${options.handoff.kind}` } : {},
  );
  return destination;
}

export async function navigateAfterWriteWithCompactToken(
  commandResult: unknown,
  destinationRoute: string,
  options: PlatformCompactPostWriteTokenOptions,
): Promise<string> {
  return navigateAfterWriteFromSourcesWithCompactToken([commandResult], destinationRoute, options);
}

export async function navigateAfterWriteFromSourcesWithCompactToken(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: PlatformCompactPostWriteTokenOptions,
): Promise<string> {
  const nowMs = options.nowMs ?? Date.now();
  const payload = createPostWriteTokenPayloadFromSources(commandResults, {
    handoff: options.handoff,
    nowMs,
  });

  if (!payload) {
    recordPostWriteTelemetry(
      options.telemetry,
      "navigation_missing_receipt",
      options.handoff ? { correctionSource: `semantic-handoff:${options.handoff.kind}` } : {},
    );
    return destinationRoute;
  }

  const token = await options.postWriteTokenStore.storePostWriteToken(payload, {
    nowMs,
    ttlMs: options.postWriteTokenTtlMs ?? DEFAULT_POST_WRITE_TOKEN_TTL_MS,
  });
  const destination = appendCompactPostWriteToken(destinationRoute, token);
  recordPostWriteTelemetry(
    options.telemetry,
    "navigation_encoded",
    options.handoff ? { correctionSource: `semantic-handoff:${options.handoff.kind}` } : {},
  );
  return destination;
}

function createPlatformPostWriteRedirectResponse(
  destination: string,
  options: PlatformCompactRedirectAfterWriteOptions,
): Response {
  const headers = new Headers(options.headers);
  headers.set("Location", destination);
  if (options.continuation === "cookie-backed") {
    headers.set(COOKIE_BACKED_CONTINUATION_RELOAD_HEADER, "true");
  }

  return new Response(null, { status: options.status ?? 302, headers });
}

export function redirectAfterWrite(
  commandResult: unknown,
  destinationRoute: string,
  options: PlatformRedirectAfterWriteOptions = {},
): Response {
  return redirectAfterWriteFromSources([commandResult], destinationRoute, options);
}

export function redirectAfterWriteFromSources(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: PlatformRedirectAfterWriteOptions = {},
): Response {
  const response = redirectAfterWriteFromSourcesWithContract(commandResults, destinationRoute, options);
  const destination = response.headers.get("Location") ?? destinationRoute;
  recordPostWriteTelemetry(
    options.telemetry,
    readFreshWriteToken(destination, options.nowMs) ? "navigation_encoded" : "navigation_missing_receipt",
    options.handoff ? { correctionSource: `semantic-handoff:${options.handoff.kind}` } : {},
  );
  return response;
}

export async function redirectAfterWriteWithCompactToken(
  commandResult: unknown,
  destinationRoute: string,
  options: PlatformCompactRedirectAfterWriteOptions,
): Promise<Response> {
  return redirectAfterWriteFromSourcesWithCompactToken([commandResult], destinationRoute, options);
}

export async function redirectAfterWriteFromSourcesWithCompactToken(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: PlatformCompactRedirectAfterWriteOptions,
): Promise<Response> {
  const destination = await navigateAfterWriteFromSourcesWithCompactToken(commandResults, destinationRoute, options);
  return createPlatformPostWriteRedirectResponse(destination, options);
}

export async function loadAfterWrite<T>(options: PlatformLoadAfterWriteOptions<T>): Promise<LoadAfterWriteResult<T>> {
  const { postWriteTokenResolver, telemetry, ...contractOptions } = options;
  let request: Request;
  try {
    request = await resolvePostWriteTokenRequest(options.request, postWriteTokenResolver);
  } catch (error) {
    if (error instanceof UnresolvedPostWriteTokenError) {
      const result = unresolvedPostWriteTokenResult<T>(error);
      recordPostWriteTelemetry(telemetry, postWriteReadOutcome(result), {
        recoveryAction: "terminal-failure",
        freshnessOutcome: "fresh-write-read-permanent",
      });
      return result;
    }

    throw error;
  }

  const result = await loadAfterWriteWithContract({ ...contractOptions, request });
  const recoveryAction = result.kind === "data" ? "none" : "recoveryKind" in result ? result.recoveryKind : "unknown";
  const correctionSource =
    "handoff" in result && result.handoff && result.handoff.kind !== "not-applicable"
      ? `semantic-handoff:${result.handoff.handoff.kind}`
      : "state" in result && result.state.handoff
        ? `semantic-handoff:${result.state.handoff.kind}`
        : telemetry?.correctionSource;

  recordPostWriteTelemetry(telemetry, postWriteReadOutcome(result), {
    correctionSource,
    recoveryAction,
    freshnessOutcome: result.kind === "data" ? "fresh" : result.reason,
  });

  return result;
}

export function createPlatformInternalAuthHeaders(
  initHeaders?: HeadersInit,
  secret = resolvePlatformInternalAuthSecret(),
): Headers {
  const headers = new Headers(initHeaders);
  headers.set(PLATFORM_INTERNAL_AUTH_HEADER, secret);
  return headers;
}

export function createForwardedAuthHeaders(
  request: Request,
  initHeaders?: HeadersInit,
  options: Readonly<{
    readTargetContextName?: string;
    nowMs?: number;
    maxAgeMs?: number;
    trustForwardedHeaders?: boolean;
  }> = {},
): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const freshWrite = readFreshWriteToken(request, options.nowMs, options.maxAgeMs);
  const publicOrigin = new URL(resolvePublicRequestOrigin(request, options));

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  if (freshWrite && !headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)) {
    headers.set(CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt(freshWrite));
  }

  if (options.readTargetContextName && !headers.has(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)) {
    headers.set(CHASE_SETS_READ_TARGET_CONTEXT_HEADER, options.readTargetContextName);
  }

  if (!headers.has("x-forwarded-proto")) {
    headers.set("x-forwarded-proto", publicOrigin.protocol.replace(/:$/, ""));
  }

  if (!headers.has("x-forwarded-host")) {
    headers.set("x-forwarded-host", publicOrigin.host);
  }

  return headers;
}

export async function createForwardedAuthHeadersAsync(
  request: Request,
  initHeaders?: HeadersInit,
  options: PlatformForwardedAuthHeadersOptions = {},
): Promise<Headers> {
  const resolvedRequest = await resolvePostWriteTokenRequest(request, options.postWriteTokenResolver);
  return createForwardedAuthHeaders(resolvedRequest, initHeaders, {
    readTargetContextName: options.readTargetContextName,
    nowMs: options.nowMs,
    maxAgeMs: options.maxAgeMs,
    trustForwardedHeaders: options.trustForwardedHeaders,
  });
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: Readonly<{
    readTargetContextName?: string;
    nowMs?: number;
    maxAgeMs?: number;
    trustForwardedHeaders?: boolean;
  }> = {},
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers, options),
    });
}

export function resolveRequestApiBaseUrl(
  request: Request,
  apiBasePath: string,
  options: PlatformRequestApiBaseUrlOptions = {},
): string {
  const internalApiOrigin = resolveInternalApiOrigin();
  if (internalApiOrigin) {
    return new URL(apiBasePath, `${internalApiOrigin}/`).toString().replace(/\/$/, "");
  }

  if (options.requireInternalApiOrigin && !isLocalRequest(request) && hasBrowserCredentials(request)) {
    throw new MissingInternalApiOriginError();
  }

  return `${resolvePublicRequestOrigin(request, options)}${apiBasePath}`;
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim().toLowerCase();
}

function forwardedValues(value: string | null) {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

function trustedForwardedClientAddress(value: string | null) {
  const parts = forwardedValues(value);
  const nearestNonPrivate = [...parts].reverse().find((part) => !isLocalHost(part) && !isPrivateNetworkAddress(part));
  return (nearestNonPrivate ?? parts[parts.length - 1] ?? null)?.toLowerCase() ?? null;
}

function isPrivateNetworkAddress(host: string) {
  const hostname = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0])?.toLowerCase() ?? "";
  if (
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
  ) {
    return true;
  }

  const private172Match = /^172\.(\d+)\./.exec(hostname);
  if (!private172Match) {
    return false;
  }

  const secondOctet = Number.parseInt(private172Match[1]!, 10);
  return secondOctet >= 16 && secondOctet <= 31;
}

function isLocalHost(host: string) {
  const hostname = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0])?.toLowerCase() ?? "";
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".test")
  );
}

function isLocalRequest(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  return isLocalHost(host) || isLocalHost(url.host);
}

function hasBrowserCredentials(request: Request) {
  return Boolean(request.headers.get("cookie") || request.headers.get("authorization"));
}

export function trustForwardedHeaders(env: Readonly<Record<string, string | undefined>> = readProcessEnv()): boolean {
  return env[CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV]?.trim().toLowerCase() === "true";
}

function shouldTrustForwardedHeaders(options: PlatformRequestOriginOptions = {}) {
  return options.trustForwardedHeaders ?? trustForwardedHeaders();
}

export function resolvePublicRequestOrigin(request: Request, options: PlatformRequestOriginOptions = {}): string {
  const url = new URL(request.url);
  const trusted = shouldTrustForwardedHeaders(options);
  const forwardedProto = trusted ? firstForwardedValue(request.headers.get("x-forwarded-proto")) : null;
  const forwardedHost = trusted ? firstForwardedValue(request.headers.get("x-forwarded-host")) : null;
  const host = forwardedHost || request.headers.get("host") || url.host;
  const protocol =
    forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : url.protocol.replace(/:$/, "");

  return `${protocol === "http" && !isLocalHost(host) ? "https" : protocol}://${host}`;
}

export function resolveClientAddress(
  request: Request | undefined,
  options: PlatformRequestOriginOptions = {},
): string | null {
  if (!request || !shouldTrustForwardedHeaders(options)) {
    return null;
  }

  return (
    trustedForwardedClientAddress(request.headers.get("x-forwarded-for")) ??
    request.headers.get("x-real-ip")?.trim() ??
    null
  );
}

export function resolveInternalApiOrigin(
  env: Readonly<Record<string, string | undefined>> = readProcessEnv(),
): string | null {
  const configured = env[CHASE_SETS_INTERNAL_API_ORIGIN_ENV]?.trim();
  if (!configured) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch (error) {
    throw new Error(`${CHASE_SETS_INTERNAL_API_ORIGIN_ENV} must be a valid absolute URL.`, { cause: error });
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process === "undefined" ? {} : process.env;
}
