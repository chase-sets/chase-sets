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
import { t } from "@chase-sets/localization";
import type { ResolvedActor } from "./auth";

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

export type RouteFunctionArgs = Readonly<{
  request: Request;
  params: Readonly<Record<string, string | undefined>>;
  context?: unknown;
}>;

export type RouteApiErrorAdapter = Readonly<{
  isError(error: unknown): boolean;
  getStatus(error: unknown): number | null;
  getBody(error: unknown): unknown;
  getErrorCode(error: unknown): string | null;
  getMessage(error: unknown): string;
}>;

export type RouteAuthorization = Readonly<{
  permission?: string;
  signInPath?: string;
  authApiBasePath?: string;
}>;

export type RouteAuthorizer = (args: RouteFunctionArgs) => Promise<ResolvedActor | null>;

export type FormActionContext = RouteFunctionArgs &
  Readonly<{
    actor: ResolvedActor | null;
    formData: FormData;
    intent: string;
  }>;

export type FormActionRedirect = Readonly<{
  kind: "form-action-redirect";
  commandResults: readonly unknown[];
  destination: string;
  options?: PlatformRedirectAfterWriteOptions;
}>;

export type FormActionIntentHandler = (context: FormActionContext) => unknown | Promise<unknown>;

export type DefineFormActionOptions<
  TIntents extends Readonly<Record<string, FormActionIntentHandler>>,
  TApiErrorResult = never,
  TErrorResult = never,
  TUnknownIntentResult = never,
  TErrorAdapter extends RouteApiErrorAdapter | undefined = undefined,
> = Readonly<{
  intents: TIntents;
  prepare?: (args: RouteFunctionArgs) => RouteFunctionArgs | Promise<RouteFunctionArgs>;
  authorization?: RouteAuthorization | RouteAuthorizer;
  errorAdapter?: TErrorAdapter;
  intentField?: string;
  readIntent?: (formData: FormData, intentField: string) => string;
  defaultIntent?: keyof TIntents & string;
  onApiError?: (error: unknown, context: FormActionContext) => TApiErrorResult | Promise<TApiErrorResult>;
  onError?: (error: unknown, context: FormActionContext) => TErrorResult | Promise<TErrorResult>;
  onUnknownIntent?: (context: FormActionContext) => TUnknownIntentResult | Promise<TUnknownIntentResult>;
}>;

type FinalizedFormActionResult<TResult> = TResult extends FormActionRedirect ? Response : TResult;

type FormActionResult<
  TIntents extends Readonly<Record<string, FormActionIntentHandler>>,
  TApiErrorResult,
  TErrorResult,
  TUnknownIntentResult,
  TErrorAdapter extends RouteApiErrorAdapter | undefined,
> = FinalizedFormActionResult<
  | Awaited<ReturnType<TIntents[keyof TIntents]>>
  | Awaited<TApiErrorResult>
  | Awaited<TErrorResult>
  | Awaited<TUnknownIntentResult>
  | (TErrorAdapter extends RouteApiErrorAdapter ? { error: string } : never)
>;

type ReadAfterWriteRouteEndpoint = Readonly<{
  routeId?: string;
  routeIds?: readonly string[];
  helperUses?: readonly string[];
}>;

export type RouteContextManifest = Readonly<{
  contextName: string;
  readAfterWriteRouteInventory?: readonly Readonly<{
    source?: ReadAfterWriteRouteEndpoint;
    destination?: ReadAfterWriteRouteEndpoint;
  }>[];
}>;

export type ResourceRouteLoadContext = RouteFunctionArgs & Readonly<{ actor: ResolvedActor | null }>;

export type ResourceRouteFailureMessages = Readonly<{
  pending?: string;
  pendingStatusText?: string;
  unverified?: string;
  notFound?: string;
}>;

export type DefineResourceRouteOptions<
  TResource,
  TData,
  TPendingData = TData,
  TPermanentFailureData = TData,
> = Readonly<{
  manifest: RouteContextManifest;
  routeId: string;
  prepare?: (args: RouteFunctionArgs) => RouteFunctionArgs | Promise<RouteFunctionArgs>;
  authorization?: RouteAuthorization | RouteAuthorizer;
  errorAdapter: RouteApiErrorAdapter;
  load(context: ResourceRouteLoadContext): Promise<TResource>;
  map(resource: TResource, context: ResourceRouteLoadContext): TData | Promise<TData>;
  messages?: ResourceRouteFailureMessages;
  telemetry?: Omit<PlatformPostWriteTelemetry, "boundedContextName" | "routeId">;
  onPending?: (
    result: Extract<LoadAfterWriteResult<TResource>, { kind: "pending" }>,
    context: ResourceRouteLoadContext,
  ) => TPendingData | Promise<TPendingData>;
  onPermanentFailure?: (
    result: Extract<LoadAfterWriteResult<TResource>, { kind: "permanent-failure" }>,
    context: ResourceRouteLoadContext,
  ) => TPermanentFailureData | Promise<TPermanentFailureData>;
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

function readErrorCodeFromBody(body: unknown): string | null {
  const detail = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof detail === "object" && detail !== null && "code" in detail ? detail.code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

export function defineApiErrorAdapter<TError>(
  options: Readonly<{
    isError(error: unknown): error is TError;
    getStatus(error: TError): number | null;
    getBody?: (error: TError) => unknown;
    getErrorCode?: (error: TError) => string | null;
    getMessage?: (error: TError) => string;
  }>,
): RouteApiErrorAdapter {
  const body = (error: TError) => options.getBody?.(error) ?? null;

  return {
    isError: options.isError,
    getStatus: (error) => (options.isError(error) ? options.getStatus(error) : null),
    getBody: (error) => (options.isError(error) ? body(error) : null),
    getErrorCode: (error) =>
      options.isError(error) ? (options.getErrorCode?.(error) ?? readErrorCodeFromBody(body(error))) : null,
    getMessage: (error) =>
      options.isError(error)
        ? (options.getMessage?.(error) ?? (error instanceof Error ? error.message : String(error)))
        : "",
  };
}

export function formActionRedirect(
  commandResult: unknown,
  destination: string,
  options?: PlatformRedirectAfterWriteOptions,
): FormActionRedirect {
  return formActionRedirectFromSources([commandResult], destination, options);
}

export function formActionRedirectFromSources(
  commandResults: readonly unknown[],
  destination: string,
  options?: PlatformRedirectAfterWriteOptions,
): FormActionRedirect {
  return {
    kind: "form-action-redirect",
    commandResults,
    destination,
    ...(options ? { options } : {}),
  };
}

function isFormActionRedirect(value: unknown): value is FormActionRedirect {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "form-action-redirect";
}

async function authorizeRoute(
  args: RouteFunctionArgs,
  authorization: RouteAuthorization | RouteAuthorizer | undefined,
): Promise<ResolvedActor | null> {
  if (!authorization) {
    return null;
  }

  if (typeof authorization === "function") {
    return authorization(args);
  }

  const { requireActorFromAuthApi } = await import("@chase-sets/platform-runtime/auth");
  return requireActorFromAuthApi({
    request: args.request,
    ...(authorization.permission ? { permission: authorization.permission } : {}),
    ...(authorization.signInPath ? { signInPath: authorization.signInPath } : {}),
    ...(authorization.authApiBasePath ? { authApiBasePath: authorization.authApiBasePath } : {}),
  });
}

export function defineFormAction<
  const TIntents extends Readonly<Record<string, FormActionIntentHandler>>,
  TApiErrorResult = never,
  TErrorResult = never,
  TUnknownIntentResult = never,
  TErrorAdapter extends RouteApiErrorAdapter | undefined = undefined,
>(
  options: DefineFormActionOptions<TIntents, TApiErrorResult, TErrorResult, TUnknownIntentResult, TErrorAdapter>,
): (
  args: RouteFunctionArgs,
) => Promise<FormActionResult<TIntents, TApiErrorResult, TErrorResult, TUnknownIntentResult, TErrorAdapter>> {
  const action = async (args: RouteFunctionArgs) => {
    const finalize = (result: unknown) =>
      isFormActionRedirect(result)
        ? redirectAfterWriteFromSources(result.commandResults, result.destination, result.options)
        : result;
    args = options.prepare ? await options.prepare(args) : args;
    const actor = await authorizeRoute(args, options.authorization);
    const formData = await args.request.formData();
    const intentField = options.intentField ?? "intent";
    const intent = options.readIntent
      ? options.readIntent(formData, intentField)
      : String(formData.get(intentField) ?? options.defaultIntent ?? "");
    const context: FormActionContext = { ...args, actor, formData, intent };
    const handler = options.intents[intent];

    if (!handler) {
      if (options.onUnknownIntent) {
        return finalize(await options.onUnknownIntent(context));
      }

      throw new Response(t("localization.routeAction.unsupportedIntent"), { status: 400 });
    }

    try {
      const result = await handler(context);
      return finalize(result);
    } catch (error) {
      if (error instanceof Response) {
        throw error;
      }

      if (options.errorAdapter?.isError(error)) {
        if (options.onApiError) {
          return finalize(await options.onApiError(error, context));
        }

        return { error: options.errorAdapter.getMessage(error) };
      }

      if (options.onError) {
        return finalize(await options.onError(error, context));
      }

      throw error;
    }
  };

  return action as (
    args: RouteFunctionArgs,
  ) => Promise<FormActionResult<TIntents, TApiErrorResult, TErrorResult, TUnknownIntentResult, TErrorAdapter>>;
}

function endpointIncludesRoute(endpoint: ReadAfterWriteRouteEndpoint | undefined, routeId: string) {
  return endpoint?.routeId === routeId || endpoint?.routeIds?.includes(routeId) === true;
}

function assertManifestDeclaresResourceRoute(manifest: RouteContextManifest, routeId: string) {
  const declared = manifest.readAfterWriteRouteInventory?.some(
    (entry) =>
      endpointIncludesRoute(entry.destination, routeId) && entry.destination?.helperUses?.includes("loadAfterWrite"),
  );

  if (!declared) {
    throw new Error(
      `Context '${manifest.contextName}' route '${routeId}' must declare loadAfterWrite in readAfterWriteRouteInventory.`,
    );
  }
}

export function defineResourceRoute<TResource, TData, TPendingData = TData, TPermanentFailureData = TData>(
  options: DefineResourceRouteOptions<TResource, TData, TPendingData, TPermanentFailureData>,
) {
  assertManifestDeclaresResourceRoute(options.manifest, options.routeId);

  return async (args: RouteFunctionArgs): Promise<TData | TPendingData | TPermanentFailureData> => {
    args = options.prepare ? await options.prepare(args) : args;
    const actor = await authorizeRoute(args, options.authorization);
    const context: ResourceRouteLoadContext = { ...args, actor };
    const result = await loadAfterWrite({
      request: args.request,
      load: () => options.load(context),
      isNotFound: (error) => options.errorAdapter.getStatus(error) === 404,
      getStatus: options.errorAdapter.getStatus,
      getErrorCode: options.errorAdapter.getErrorCode,
      getBody: options.errorAdapter.getBody,
      telemetry: {
        boundedContextName: options.manifest.contextName,
        surface: options.telemetry?.surface ?? options.routeId,
        routeId: options.routeId,
        ...options.telemetry,
      },
    });

    if (result.kind === "data") {
      return options.map(result.data, context);
    }

    if (result.kind === "pending") {
      if (options.onPending) {
        return options.onPending(result, context);
      }

      throw new Response(options.messages?.pending ?? t("localization.routeResource.pending"), {
        status: 503,
        ...(options.messages?.pendingStatusText ? { statusText: options.messages.pendingStatusText } : {}),
      });
    }

    if (options.onPermanentFailure) {
      return options.onPermanentFailure(result, context);
    }

    if (result.reason !== "fresh-write-read-permanent") {
      throw new Response(options.messages?.unverified ?? t("localization.routeResource.unverified"), { status: 409 });
    }

    if ("error" in result && options.errorAdapter.getStatus(result.error) === 404) {
      throw new Response(options.messages?.notFound ?? t("localization.routeResource.notFound"), { status: 404 });
    }

    if ("error" in result) {
      throw result.error;
    }

    throw new Response(options.messages?.notFound ?? t("localization.routeResource.notFound"), { status: 404 });
  };
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
