import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
  loadAfterWrite as loadAfterWriteWithContract,
  navigateAfterWrite as navigateAfterWriteWithContract,
  navigateAfterWriteFromSources as navigateAfterWriteFromSourcesWithContract,
  readFreshWriteToken,
  type LoadAfterWriteOptions,
  type LoadAfterWriteResult,
  type NavigateAfterWriteOptions,
} from "@chase-sets/http/responses";
import {
  recordPlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyEvent,
  type PlatformPostWriteConsistencyOutcome,
} from "./post-write-consistency";

export const PLATFORM_INTERNAL_AUTH_HEADER = "x-chase-sets-internal-auth";
export const PLATFORM_INTERNAL_AUTH_SECRET_ENV = "PLATFORM_INTERNAL_AUTH_SECRET";
export const CHASE_SETS_INTERNAL_API_ORIGIN_ENV = "CHASE_SETS_INTERNAL_API_ORIGIN";
const DEFAULT_DEV_INTERNAL_AUTH_SECRET = "dev-platform-internal-auth-secret";

export type PlatformPostWriteTelemetry = Readonly<
  Omit<PlatformPostWriteConsistencyEvent, "outcome" | "strategy"> & {
    strategy?: string;
  }
>;

export type PlatformNavigateAfterWriteOptions = NavigateAfterWriteOptions &
  Readonly<{
    telemetry?: PlatformPostWriteTelemetry;
  }>;

export type PlatformLoadAfterWriteOptions<T> = LoadAfterWriteOptions<T> &
  Readonly<{
    telemetry?: PlatformPostWriteTelemetry;
  }>;

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

export function resolvePlatformInternalAuthSecret(options: Readonly<{ requireExplicitInProduction?: boolean }> = {}) {
  const configured = process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV]?.trim();
  if (options.requireExplicitInProduction && process.env.NODE_ENV === "production" && !configured) {
    throw new Error(`${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API calls in production.`);
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

export async function loadAfterWrite<T>(options: PlatformLoadAfterWriteOptions<T>): Promise<LoadAfterWriteResult<T>> {
  const result = await loadAfterWriteWithContract(options);
  const recoveryAction = result.kind === "data" ? "none" : "recoveryKind" in result ? result.recoveryKind : "unknown";
  const correctionSource =
    "handoff" in result && result.handoff && result.handoff.kind !== "not-applicable"
      ? `semantic-handoff:${result.handoff.handoff.kind}`
      : "state" in result && result.state.handoff
        ? `semantic-handoff:${result.state.handoff.kind}`
        : options.telemetry?.correctionSource;

  recordPostWriteTelemetry(options.telemetry, postWriteReadOutcome(result), {
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
  options: Readonly<{ readTargetContextName?: string }> = {},
): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const freshWrite = readFreshWriteToken(request);

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

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: Readonly<{ readTargetContextName?: string }> = {},
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers, options),
    });
}

export function resolveRequestApiBaseUrl(request: Request, apiBasePath: string): string {
  const internalApiOrigin = resolveInternalApiOrigin();
  if (internalApiOrigin) {
    return new URL(apiBasePath, `${internalApiOrigin}/`).toString().replace(/\/$/, "");
  }

  return `${resolvePublicRequestOrigin(request)}${apiBasePath}`;
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim().toLowerCase();
}

function isLocalHost(host: string) {
  const hostname = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0])?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function resolvePublicRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost || request.headers.get("host") || url.host;
  const protocol =
    forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : url.protocol.replace(/:$/, "");

  return `${protocol === "http" && !isLocalHost(host) ? "https" : protocol}://${host}`;
}

export function resolveInternalApiOrigin(
  env: Readonly<Record<string, string | undefined>> = readProcessEnv(),
): string | null {
  const configured = env[CHASE_SETS_INTERNAL_API_ORIGIN_ENV]?.trim();
  if (!configured) {
    return null;
  }

  const url = new URL(configured);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process === "undefined" ? {} : process.env;
}
