export interface ListResponse<T> {
  items: T[];
  total: number;
  count: number;
}

export interface CommandResponse {
  id: string;
  version: number;
  status: string;
}

export interface SourceCommitPosition {
  sourceContextName: string;
  maxGlobalPosition: string;
  eventIds: readonly string[];
}

export interface ResponseConsistencyMetadata {
  mode: "eventual" | string;
  commitPosition?: string;
  commitEventIds: readonly string[];
  commitPositions: readonly SourceCommitPosition[];
}

export interface ResponseMetadata {
  consistency: ResponseConsistencyMetadata | null;
}

export type CommandReceiptMetadata = ResponseConsistencyMetadata;

export type MutationResult<T extends object> = T & {
  readonly commandReceipt: CommandReceiptMetadata | null;
};

export type ApiErrorCode =
  | "authentication_required"
  | "authorization_forbidden"
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "projection_freshness_timeout"
  | "provider_failed"
  | "internal_error";

export interface ApiErrorDetail {
  field?: string;
  code?: string;
  message: string;
}

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetail[];
  };
}

export function apiErrorResponse(
  code: ApiErrorCode,
  message: string,
  details?: readonly ApiErrorDetail[],
): ApiErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details: [...details] } : {}),
    },
  };
}

export function authenticationRequiredResponse(message = "Authentication required."): ApiErrorResponse {
  return apiErrorResponse("authentication_required", message);
}

export function forbiddenResponse(message = "Forbidden."): ApiErrorResponse {
  return apiErrorResponse("authorization_forbidden", message);
}

export function validationFailedResponse(message: string, details?: readonly ApiErrorDetail[]): ApiErrorResponse {
  return apiErrorResponse("validation_failed", message, details);
}

export function notFoundResponse(message: string): ApiErrorResponse {
  return apiErrorResponse("not_found", message);
}

export function conflictResponse(message: string): ApiErrorResponse {
  return apiErrorResponse("conflict", message);
}

export function internalErrorResponse(message = "Internal server error."): ApiErrorResponse {
  return apiErrorResponse("internal_error", message);
}

export function commandResponse(id: string, version: number, status = "accepted"): CommandResponse {
  return { id, version, status };
}

const RESPONSE_METADATA = Symbol.for("@chase-sets/http.response-metadata");
const FRESH_WRITE_PARAM = "afterWrite";
const POST_WRITE_HANDOFF_PARAM = "postWriteHandoff";
export const POST_WRITE_TOKEN_PARAM = "postWriteToken";
const DEFAULT_FRESH_WRITE_MAX_AGE_MS = 30_000;
const DEFAULT_FRESH_WRITE_CLOCK_SKEW_MS = 5_000;
const DEFAULT_FRESH_WRITE_RETRY_DELAYS_MS = [75, 150, 300, 600, 1_000] as const;
export const COOKIE_BACKED_CONTINUATION_RELOAD_HEADER = "X-Remix-Reload-Document";
export const CHASE_SETS_COMMIT_RECEIPT_HEADER = "Chase-Sets-Commit-Receipt";
export const CHASE_SETS_READ_AFTER_WRITE_HEADER = "Chase-Sets-Read-After-Write";
export const CHASE_SETS_READ_TARGET_CONTEXT_HEADER = "Chase-Sets-Read-Target-Context";

export type FreshWriteReceipt = Readonly<{
  observedAtMs: number;
  commitPosition?: string;
  sources: readonly SourceCommitPosition[];
}>;

export type FreshWriteTokenState =
  | Readonly<{ kind: "missing"; receipt: null }>
  | Readonly<{ kind: "valid"; receipt: FreshWriteReceipt; ageMs: number }>
  | Readonly<{ kind: "malformed"; receipt: null }>
  | Readonly<{ kind: "expired"; receipt: null; observedAtMs: number; ageMs: number; maxAgeMs: number }>
  | Readonly<{ kind: "future"; receipt: null; observedAtMs: number; ageMs: number; clockSkewMs: number }>;

export type FreshWriteReadErrorKind =
  | "transient-not-found"
  | "transient-projection-timeout"
  | "transient-gateway-timeout"
  | "permanent-not-found"
  | "not-fresh-write"
  | "fresh-write-unhandled";

export type FreshWriteReadErrorClassification = Readonly<{
  kind: FreshWriteReadErrorKind;
  transient: boolean;
  receipt: FreshWriteReceipt | null;
  status: number | null;
  errorCode: string | null;
}>;

export const POST_WRITE_RECOVERY_KINDS = [
  "pending-projection",
  "refreshable-catching-up",
  "stale-projection",
  "action-required",
  "expired-handoff",
  "terminal-failure",
] as const;

export type PostWriteRecoveryKind = (typeof POST_WRITE_RECOVERY_KINDS)[number];

export function isBoundedTemporaryPostWriteRecoveryKind(kind: PostWriteRecoveryKind): boolean {
  return kind === "pending-projection" || kind === "refreshable-catching-up";
}

export const POST_WRITE_HANDOFF_EXPECTATIONS = [
  "resource-present",
  "resource-updated",
  "resource-absent",
  "collection-non-empty",
] as const;

export type PostWriteHandoffExpectation = (typeof POST_WRITE_HANDOFF_EXPECTATIONS)[number];

export type PostWriteHandoff = Readonly<{
  kind: string;
  expectation: PostWriteHandoffExpectation;
  surface?: string;
}>;

export type PostWriteTokenPayload = Readonly<{
  receipt: FreshWriteReceipt;
  handoff?: PostWriteHandoff;
}>;

export type StorePostWriteTokenOptions = Readonly<{
  nowMs: number;
  ttlMs: number;
}>;

export type PostWriteTokenResolver = Readonly<{
  resolvePostWriteToken: (token: string) => Promise<PostWriteTokenPayload | null>;
}>;

export type PostWriteTokenStore = PostWriteTokenResolver &
  Readonly<{
    storePostWriteToken: (payload: PostWriteTokenPayload, options: StorePostWriteTokenOptions) => Promise<string>;
  }>;

export type PostWriteHandoffState =
  | Readonly<{ kind: "missing"; handoff: null; freshWrite: FreshWriteTokenState }>
  | Readonly<{ kind: "malformed"; handoff: null; freshWrite: FreshWriteTokenState }>
  | Readonly<{ kind: "not-fresh-write"; handoff: PostWriteHandoff; freshWrite: FreshWriteTokenState }>
  | Readonly<{
      kind: "valid";
      handoff: PostWriteHandoff;
      receipt: FreshWriteReceipt;
      ageMs: number;
      freshWrite: Extract<FreshWriteTokenState, { kind: "valid" }>;
    }>;

export type PostWriteHandoffEvaluation<T> =
  | Readonly<{ kind: "not-applicable"; data: T; state: Exclude<PostWriteHandoffState, { kind: "valid" }> }>
  | Readonly<{
      kind: "satisfied";
      data: T;
      handoff: PostWriteHandoff;
      receipt: FreshWriteReceipt;
      ageMs: number;
    }>
  | Readonly<{
      kind: "pending";
      data: T;
      handoff: PostWriteHandoff;
      receipt: FreshWriteReceipt;
      ageMs: number;
    }>;

export type NavigateAfterWriteOptions = Readonly<{
  handoff?: PostWriteHandoff;
  continuation?: "url" | "cookie-backed";
  nowMs?: number;
}>;

export type RedirectAfterWriteOptions = NavigateAfterWriteOptions &
  Readonly<{
    headers?: HeadersInit;
    status?: 302 | 303;
  }>;

export type FreshWriteReadRecoveryOptions<T> = Readonly<{
  request: Request | string | URL;
  error: unknown;
  recoverTransient: (classification: FreshWriteReadErrorClassification) => T;
  recoverPermanent?: (classification: FreshWriteReadErrorClassification) => T | null;
  nowMs?: number;
  maxAgeMs?: number;
  getStatus?: (error: unknown) => number | null;
  getErrorCode?: (error: unknown) => string | null;
  getBody?: (error: unknown) => unknown;
}>;

export type PostWriteRouteRecoveryClassification =
  | Readonly<{
      kind: "recover";
      reason: "fresh-write-read-transient";
      recoveryKind: PostWriteRecoveryKind;
      readError: FreshWriteReadErrorClassification;
    }>
  | Readonly<{
      kind: "pass-through";
      reason: "not-post-write-transient";
      recoveryKind: PostWriteRecoveryKind;
      readError: FreshWriteReadErrorClassification;
    }>;

export type PostWriteRouteRecoveryOptions = Readonly<{
  request: Request | string | URL;
  status: number | null;
  body?: unknown;
  nowMs?: number;
  maxAgeMs?: number;
}>;

export type LoadAfterWriteOptions<T> = Readonly<{
  request: Request;
  load: () => Promise<T>;
  isNotFound: (error: unknown) => boolean;
  isHandoffSatisfied?: (data: T, handoff: PostWriteHandoff) => boolean;
  waitForFreshness?: (receipt: FreshWriteReceipt) => Promise<void>;
  retryDelaysMs?: readonly number[];
  nowMs?: () => number;
  maxAgeMs?: number;
  clockSkewMs?: number;
  getStatus?: (error: unknown) => number | null;
  getErrorCode?: (error: unknown) => string | null;
  getBody?: (error: unknown) => unknown;
}>;

export type LoadAfterWriteResult<T> =
  | Readonly<{
      kind: "data";
      data: T;
      handoff: PostWriteHandoffEvaluation<T> | null;
    }>
  | Readonly<{
      kind: "pending";
      reason: "fresh-write-read-transient";
      data: null;
      recoveryKind: PostWriteRecoveryKind;
      classification: FreshWriteReadErrorClassification;
      error: unknown;
    }>
  | Readonly<{
      kind: "pending";
      reason: "semantic-handoff-pending";
      data: T;
      recoveryKind: PostWriteRecoveryKind;
      handoff: Extract<PostWriteHandoffEvaluation<T>, { kind: "pending" }>;
    }>
  | Readonly<{
      kind: "permanent-failure";
      reason: "fresh-write-read-permanent";
      recoveryKind: PostWriteRecoveryKind;
      classification: FreshWriteReadErrorClassification;
      error: unknown;
    }>
  | Readonly<{
      kind: "permanent-failure";
      reason: "semantic-handoff-expired" | "semantic-handoff-malformed" | "semantic-handoff-invalid";
      recoveryKind: PostWriteRecoveryKind;
      state: Exclude<PostWriteHandoffState, { kind: "valid" | "missing" }>;
    }>;

export type PostWriteDestinationResultClassification<T> =
  | Readonly<{
      kind: "data";
      data: T;
      result: Extract<LoadAfterWriteResult<T>, { kind: "data" }>;
    }>
  | Readonly<{
      kind: "recover";
      reason: Extract<LoadAfterWriteResult<T>, { kind: "pending" }>["reason"];
      recoveryKind: PostWriteRecoveryKind;
      data: T | null;
      result: Extract<LoadAfterWriteResult<T>, { kind: "pending" }>;
    }>
  | Readonly<{
      kind: "pass-through";
      reason: Extract<LoadAfterWriteResult<T>, { kind: "permanent-failure" }>["reason"];
      recoveryKind: PostWriteRecoveryKind;
      result: Extract<LoadAfterWriteResult<T>, { kind: "permanent-failure" }>;
    }>;

type MetadataCarrier = {
  [RESPONSE_METADATA]?: ResponseMetadata;
};

type CommandReceiptCarrier = {
  commandReceipt?: CommandReceiptMetadata | null;
};

export function readResponseConsistencyMetadata(
  response: Pick<Response, "headers">,
): ResponseConsistencyMetadata | null {
  const mode = response.headers.get("Chase-Sets-Consistency");
  if (!mode) {
    return null;
  }

  const commitPosition = response.headers.get("Chase-Sets-Commit-Position") ?? undefined;
  const commitEventIds = (response.headers.get("Chase-Sets-Commit-Event-Ids") ?? "")
    .split(",")
    .map((eventId) => eventId.trim())
    .filter(Boolean);
  const commitPositions = decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER));

  return {
    mode,
    ...(commitPosition ? { commitPosition } : {}),
    commitEventIds,
    commitPositions,
  };
}

export function attachResponseMetadata<T>(body: T, response: Pick<Response, "headers">): T {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const consistency = readResponseConsistencyMetadata(response);

  Object.defineProperty(body, RESPONSE_METADATA, {
    value: {
      consistency,
    } satisfies ResponseMetadata,
    enumerable: false,
  });

  Object.defineProperty(body, "commandReceipt", {
    value: consistency,
    enumerable: false,
  });

  return body;
}

export function getResponseMetadata(value: unknown): ResponseMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return (value as MetadataCarrier)[RESPONSE_METADATA] ?? null;
}

export function getMutationResultCommandReceipt(value: unknown): CommandReceiptMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const commandReceipt = (value as CommandReceiptCarrier).commandReceipt;
  return commandReceipt && typeof commandReceipt === "object" ? commandReceipt : null;
}

function pathFromUrl(url: URL, originalPath: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(originalPath) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function isSourceCommitPosition(value: unknown): value is SourceCommitPosition {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const source = value as Record<string, unknown>;
  return (
    typeof source.sourceContextName === "string" &&
    source.sourceContextName.length > 0 &&
    typeof source.maxGlobalPosition === "string" &&
    /^(0|[1-9]\d*)$/.test(source.maxGlobalPosition) &&
    Array.isArray(source.eventIds) &&
    source.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0)
  );
}

function isFreshWriteReceipt(value: unknown): value is FreshWriteReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const receipt = value as Record<string, unknown>;
  return (
    Number.isFinite(Number(receipt.observedAtMs)) &&
    (receipt.commitPosition === undefined ||
      (typeof receipt.commitPosition === "string" && /^(0|[1-9]\d*)$/.test(receipt.commitPosition))) &&
    Array.isArray(receipt.sources) &&
    receipt.sources.every(isSourceCommitPosition) &&
    (typeof receipt.commitPosition === "string" || receipt.sources.length > 0)
  );
}

export function encodeCommitReceipt(sources: readonly SourceCommitPosition[]): string {
  return encodeURIComponent(JSON.stringify(sources));
}

export function decodeCommitReceipt(value: string | null | undefined): readonly SourceCommitPosition[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSourceCommitPosition) : [];
  } catch {
    return [];
  }
}

export function encodeFreshWriteReceipt(receipt: FreshWriteReceipt): string {
  return encodeURIComponent(JSON.stringify(receipt));
}

function normalizeFreshWriteReceipt(receipt: FreshWriteReceipt): FreshWriteReceipt {
  return {
    observedAtMs: Number(receipt.observedAtMs),
    ...(receipt.commitPosition ? { commitPosition: receipt.commitPosition } : {}),
    sources: receipt.sources.map((source) => ({
      sourceContextName: source.sourceContextName,
      maxGlobalPosition: source.maxGlobalPosition,
      eventIds: [...source.eventIds],
    })),
  };
}

function validFreshWriteState(receipt: FreshWriteReceipt, nowMs: number, maxAgeMs: number, clockSkewMs: number) {
  const ageMs = nowMs - receipt.observedAtMs;
  if (ageMs < -clockSkewMs) {
    return {
      kind: "future",
      receipt: null,
      observedAtMs: receipt.observedAtMs,
      ageMs,
      clockSkewMs,
    } satisfies FreshWriteTokenState;
  }

  if (ageMs > maxAgeMs) {
    return {
      kind: "expired",
      receipt: null,
      observedAtMs: receipt.observedAtMs,
      ageMs,
      maxAgeMs,
    } satisfies FreshWriteTokenState;
  }

  return {
    kind: "valid",
    receipt,
    ageMs,
  } satisfies FreshWriteTokenState;
}

function decodeFreshWriteReceiptState(
  value: string | null | undefined,
  nowMs: number,
  maxAgeMs: number,
  clockSkewMs: number,
): FreshWriteTokenState {
  if (!value) {
    return { kind: "missing", receipt: null };
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!isFreshWriteReceipt(parsed)) {
      return { kind: "malformed", receipt: null };
    }

    return validFreshWriteState(normalizeFreshWriteReceipt(parsed), nowMs, maxAgeMs, clockSkewMs);
  } catch {
    return { kind: "malformed", receipt: null };
  }
}

export function decodeFreshWriteReceipt(
  value: string | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
  clockSkewMs = DEFAULT_FRESH_WRITE_CLOCK_SKEW_MS,
): FreshWriteReceipt | null {
  const state = decodeFreshWriteReceiptState(value, nowMs, maxAgeMs, clockSkewMs);
  return state.kind === "valid" ? state.receipt : null;
}

function consistencyMetadataFromSource(source: unknown): ResponseConsistencyMetadata | null {
  return (
    getMutationResultCommandReceipt(source) ??
    (typeof source === "object" && source !== null && ("commitPosition" in source || "commitPositions" in source)
      ? (source as ResponseConsistencyMetadata)
      : (getResponseMetadata(source)?.consistency ?? null))
  );
}

function maxCommitPosition(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(right) > BigInt(left) ? right : left;
}

function mergeEventIds(left: readonly string[], right: readonly string[]) {
  return [...new Set([...left, ...right])];
}

function freshWriteReceiptFromMetadataSources(sources: readonly unknown[], nowMs: number): FreshWriteReceipt | null {
  let commitPosition: string | undefined;
  const commitPositions = new Map<string, SourceCommitPosition>();

  for (const source of sources) {
    const metadata = consistencyMetadataFromSource(source);
    commitPosition = maxCommitPosition(commitPosition, metadata?.commitPosition);

    for (const position of metadata?.commitPositions ?? []) {
      const current = commitPositions.get(position.sourceContextName);
      if (!current) {
        commitPositions.set(position.sourceContextName, position);
        continue;
      }

      const maxGlobalPosition = maxCommitPosition(current.maxGlobalPosition, position.maxGlobalPosition);
      commitPositions.set(position.sourceContextName, {
        sourceContextName: position.sourceContextName,
        maxGlobalPosition: maxGlobalPosition ?? position.maxGlobalPosition,
        eventIds: mergeEventIds(current.eventIds, position.eventIds),
      });
    }
  }

  const mergedCommitPositions = [...commitPositions.values()].sort((left, right) =>
    left.sourceContextName.localeCompare(right.sourceContextName),
  );
  if (!commitPosition && mergedCommitPositions.length === 0) {
    return null;
  }

  return {
    observedAtMs: nowMs,
    ...(commitPosition ? { commitPosition } : {}),
    sources: mergedCommitPositions,
  };
}

function tokenFromMetadataSources(sources: readonly unknown[], nowMs: number): string | null {
  const receipt = freshWriteReceiptFromMetadataSources(sources, nowMs);
  return receipt ? encodeFreshWriteReceipt(receipt) : null;
}

function isPortableHandoffText(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPostWriteHandoff(value: unknown): value is PostWriteHandoff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const handoff = value as Record<string, unknown>;
  return (
    hasOnlyKeys(handoff, ["kind", "expectation", "surface"]) &&
    isPortableHandoffText(handoff.kind) &&
    POST_WRITE_HANDOFF_EXPECTATIONS.includes(handoff.expectation as PostWriteHandoffExpectation) &&
    (handoff.surface === undefined || isPortableHandoffText(handoff.surface))
  );
}

export function isPostWriteTokenPayload(value: unknown): value is PostWriteTokenPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return (
    hasOnlyKeys(payload, ["receipt", "handoff"]) &&
    isFreshWriteReceipt(payload.receipt) &&
    (payload.handoff === undefined || isPostWriteHandoff(payload.handoff))
  );
}

export function isCompactPostWriteToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value);
}

function assertCompactPostWriteToken(token: string) {
  if (!isCompactPostWriteToken(token)) {
    throw new TypeError("Compact post-write tokens must be opaque URL-safe identifiers.");
  }
}

export function encodePostWriteHandoff(handoff: PostWriteHandoff): string {
  if (!isPostWriteHandoff(handoff)) {
    throw new TypeError("Post-write handoff metadata must use safe semantic fields only.");
  }

  return encodeURIComponent(JSON.stringify(handoff));
}

function decodePostWriteHandoff(value: string | null | undefined): "missing" | "malformed" | PostWriteHandoff {
  if (!value) {
    return "missing";
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    return isPostWriteHandoff(parsed) ? parsed : "malformed";
  } catch {
    return "malformed";
  }
}

export function createPostWriteTokenPayload(
  source: unknown,
  options: Readonly<{ handoff?: PostWriteHandoff; nowMs?: number }> = {},
): PostWriteTokenPayload | null {
  return createPostWriteTokenPayloadFromSources([source], options);
}

export function createPostWriteTokenPayloadFromSources(
  sources: readonly unknown[],
  options: Readonly<{ handoff?: PostWriteHandoff; nowMs?: number }> = {},
): PostWriteTokenPayload | null {
  if (options.handoff && !isPostWriteHandoff(options.handoff)) {
    throw new TypeError("Post-write handoff metadata must use safe semantic fields only.");
  }

  const receipt = freshWriteReceiptFromMetadataSources(sources, options.nowMs ?? Date.now());
  if (!receipt) {
    return null;
  }

  return {
    receipt,
    ...(options.handoff ? { handoff: options.handoff } : {}),
  };
}

export function appendCompactPostWriteToken(path: string, token: string): string {
  assertCompactPostWriteToken(token);

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.delete(FRESH_WRITE_PARAM);
  url.searchParams.delete(POST_WRITE_HANDOFF_PARAM);
  url.searchParams.set(POST_WRITE_TOKEN_PARAM, token);
  return pathFromUrl(url, path);
}

export function readCompactPostWriteToken(requestOrUrl: Request | string | URL): string | null {
  const url =
    requestOrUrl instanceof URL
      ? requestOrUrl
      : new URL(typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url, "https://chase-sets.local");
  const token = url.searchParams.get(POST_WRITE_TOKEN_PARAM);
  return isCompactPostWriteToken(token) ? token : null;
}

export function materializePostWriteTokenPayload(path: string, payload: PostWriteTokenPayload): string {
  if (!isPostWriteTokenPayload(payload)) {
    throw new TypeError("Post-write token payloads must contain only fresh-write receipt and safe handoff metadata.");
  }

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.delete(POST_WRITE_TOKEN_PARAM);
  url.searchParams.set(FRESH_WRITE_PARAM, encodeFreshWriteReceipt(normalizeFreshWriteReceipt(payload.receipt)));
  if (payload.handoff) {
    url.searchParams.set(POST_WRITE_HANDOFF_PARAM, encodePostWriteHandoff(payload.handoff));
  } else {
    url.searchParams.delete(POST_WRITE_HANDOFF_PARAM);
  }
  return pathFromUrl(url, path);
}

export function preserveFreshWriteMetadata(
  path: string,
  requestOrUrl: Request | string | URL,
  nowMs = Date.now(),
): string {
  const sourceUrl =
    requestOrUrl instanceof URL
      ? requestOrUrl
      : new URL(typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url, "https://chase-sets.local");
  const compactToken = readCompactPostWriteToken(sourceUrl);
  if (compactToken) {
    return appendCompactPostWriteToken(path, compactToken);
  }

  const afterWrite = sourceUrl.searchParams.get(FRESH_WRITE_PARAM);
  if (!afterWrite) {
    return path;
  }

  const handoffState = readPostWriteHandoffState(sourceUrl, nowMs);
  if (handoffState.kind === "valid") {
    return materializePostWriteTokenPayload(path, {
      receipt: handoffState.receipt,
      handoff: handoffState.handoff,
    });
  }

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.delete(POST_WRITE_TOKEN_PARAM);
  url.searchParams.set(FRESH_WRITE_PARAM, afterWrite);
  url.searchParams.delete(POST_WRITE_HANDOFF_PARAM);
  return pathFromUrl(url, path);
}

function appendPostWriteHandoffFromMetadataSources(
  path: string,
  sources: readonly unknown[],
  handoff: PostWriteHandoff,
  nowMs: number,
): string {
  const token = tokenFromMetadataSources(sources, nowMs);
  if (!token) {
    return path;
  }

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.set(FRESH_WRITE_PARAM, token);
  url.searchParams.set(POST_WRITE_HANDOFF_PARAM, encodePostWriteHandoff(handoff));
  return pathFromUrl(url, path);
}

export function appendFreshWriteToken(path: string, source: unknown, nowMs = Date.now()): string {
  const token = tokenFromMetadataSources([source], nowMs);
  if (!token) {
    return path;
  }

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.set(FRESH_WRITE_PARAM, token);
  return pathFromUrl(url, path);
}

export function appendFreshWriteTokenFromSources(
  path: string,
  sources: readonly unknown[],
  nowMs = Date.now(),
): string {
  const token = tokenFromMetadataSources(sources, nowMs);
  if (!token) {
    return path;
  }

  const url = new URL(path, "https://chase-sets.local");
  url.searchParams.set(FRESH_WRITE_PARAM, token);
  return pathFromUrl(url, path);
}

export function appendPostWriteHandoff(
  path: string,
  source: unknown,
  handoff: PostWriteHandoff,
  nowMs = Date.now(),
): string {
  return appendPostWriteHandoffFromMetadataSources(path, [source], handoff, nowMs);
}

export function navigateAfterWrite(
  commandResult: unknown,
  destinationRoute: string,
  options: NavigateAfterWriteOptions = {},
): string {
  return navigateAfterWriteFromSources([commandResult], destinationRoute, options);
}

function navigateAfterWriteFromSources(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: NavigateAfterWriteOptions = {},
): string {
  return options.handoff
    ? appendPostWriteHandoffFromMetadataSources(
        destinationRoute,
        commandResults,
        options.handoff,
        options.nowMs ?? Date.now(),
      )
    : appendFreshWriteTokenFromSources(destinationRoute, commandResults, options.nowMs);
}

function createPostWriteRedirectResponse(destination: string, options: RedirectAfterWriteOptions = {}): Response {
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
  options: RedirectAfterWriteOptions = {},
): Response {
  return redirectAfterWriteFromSources([commandResult], destinationRoute, options);
}

export function redirectAfterWriteFromSources(
  commandResults: readonly unknown[],
  destinationRoute: string,
  options: RedirectAfterWriteOptions = {},
): Response {
  return createPostWriteRedirectResponse(
    navigateAfterWriteFromSources(commandResults, destinationRoute, options),
    options,
  );
}

export function readFreshWriteToken(
  requestOrUrl: Request | string | URL,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
  clockSkewMs = DEFAULT_FRESH_WRITE_CLOCK_SKEW_MS,
): FreshWriteReceipt | null {
  const state = readFreshWriteTokenState(requestOrUrl, nowMs, maxAgeMs, clockSkewMs);
  return state.kind === "valid" ? state.receipt : null;
}

export function readFreshWriteTokenState(
  requestOrUrl: Request | string | URL,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
  clockSkewMs = DEFAULT_FRESH_WRITE_CLOCK_SKEW_MS,
): FreshWriteTokenState {
  const url =
    requestOrUrl instanceof URL
      ? requestOrUrl
      : new URL(typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url, "https://chase-sets.local");
  const token = url.searchParams.get(FRESH_WRITE_PARAM);
  if (!token) {
    return { kind: "missing", receipt: null };
  }

  try {
    if (decodeURIComponent(token).startsWith("{")) {
      return decodeFreshWriteReceiptState(token, nowMs, maxAgeMs, clockSkewMs);
    }
  } catch {
    return { kind: "malformed", receipt: null };
  }

  const [encodedPosition, observedAtText] = token.split(".");
  const observedAtMs = Number(observedAtText);
  if (!encodedPosition || !Number.isFinite(observedAtMs)) {
    return { kind: "malformed", receipt: null };
  }

  try {
    const receipt = {
      commitPosition: decodeURIComponent(encodedPosition),
      observedAtMs,
      sources: [],
    };
    return validFreshWriteState(receipt, nowMs, maxAgeMs, clockSkewMs);
  } catch {
    return { kind: "malformed", receipt: null };
  }
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return Number.isInteger(status) ? Number(status) : null;
}

function errorBody(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("body" in error)) {
    return null;
  }

  return (error as { body?: unknown }).body;
}

export function readApiErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }

  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code : null;
}

export function classifyFreshWriteReadError(
  options: Readonly<{
    request: Request | string | URL;
    error: unknown;
    nowMs?: number;
    maxAgeMs?: number;
    getStatus?: (error: unknown) => number | null;
    getErrorCode?: (error: unknown) => string | null;
    getBody?: (error: unknown) => unknown;
  }>,
): FreshWriteReadErrorClassification {
  const receipt = readFreshWriteToken(options.request, options.nowMs, options.maxAgeMs);
  const status = options.getStatus?.(options.error) ?? errorStatus(options.error);
  const errorCode =
    options.getErrorCode?.(options.error) ??
    readApiErrorCode(options.getBody?.(options.error) ?? errorBody(options.error));

  if (!receipt) {
    return {
      kind: status === 404 ? "permanent-not-found" : "not-fresh-write",
      transient: false,
      receipt: null,
      status,
      errorCode,
    };
  }

  if (status === 404) {
    return {
      kind: "transient-not-found",
      transient: true,
      receipt,
      status,
      errorCode,
    };
  }

  if (status === 503 && errorCode === "projection_freshness_timeout") {
    return {
      kind: "transient-projection-timeout",
      transient: true,
      receipt,
      status,
      errorCode,
    };
  }

  if ((status === 502 || status === 503 || status === 504) && !errorCode) {
    return {
      kind: "transient-gateway-timeout",
      transient: true,
      receipt,
      status,
      errorCode,
    };
  }

  return {
    kind: "fresh-write-unhandled",
    transient: false,
    receipt,
    status,
    errorCode,
  };
}

export function postWriteRecoveryKindForFreshWriteReadError(
  classification: FreshWriteReadErrorClassification,
): PostWriteRecoveryKind {
  if (classification.transient) {
    return "refreshable-catching-up";
  }

  return classification.kind === "fresh-write-unhandled" ? "action-required" : "terminal-failure";
}

export function classifyPostWriteRouteRecovery(
  options: PostWriteRouteRecoveryOptions,
): PostWriteRouteRecoveryClassification {
  const readError = classifyFreshWriteReadError({
    request: options.request,
    error: {
      status: options.status,
      body: options.body,
    },
    nowMs: options.nowMs,
    maxAgeMs: options.maxAgeMs,
  });
  const recoveryKind = postWriteRecoveryKindForFreshWriteReadError(readError);

  return readError.transient
    ? {
        kind: "recover",
        reason: "fresh-write-read-transient",
        recoveryKind,
        readError,
      }
    : {
        kind: "pass-through",
        reason: "not-post-write-transient",
        recoveryKind,
        readError,
      };
}

export function readPostWriteHandoffState(
  requestOrUrl: Request | string | URL,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
  clockSkewMs = DEFAULT_FRESH_WRITE_CLOCK_SKEW_MS,
): PostWriteHandoffState {
  const url =
    requestOrUrl instanceof URL
      ? requestOrUrl
      : new URL(typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url, "https://chase-sets.local");
  const freshWrite = readFreshWriteTokenState(url, nowMs, maxAgeMs, clockSkewMs);
  const decoded = decodePostWriteHandoff(url.searchParams.get(POST_WRITE_HANDOFF_PARAM));

  if (decoded === "missing") {
    return { kind: "missing", handoff: null, freshWrite };
  }

  if (decoded === "malformed") {
    return { kind: "malformed", handoff: null, freshWrite };
  }

  if (freshWrite.kind !== "valid") {
    return { kind: "not-fresh-write", handoff: decoded, freshWrite };
  }

  return {
    kind: "valid",
    handoff: decoded,
    receipt: freshWrite.receipt,
    ageMs: freshWrite.ageMs,
    freshWrite,
  };
}

export function postWriteRecoveryKindForHandoffState(state: PostWriteHandoffState): PostWriteRecoveryKind {
  switch (state.kind) {
    case "valid":
      return "pending-projection";
    case "not-fresh-write":
      return state.freshWrite.kind === "expired" ? "expired-handoff" : "terminal-failure";
    case "malformed":
    case "missing":
      return "terminal-failure";
  }
}

export function readPostWriteHandoff(
  requestOrUrl: Request | string | URL,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
  clockSkewMs = DEFAULT_FRESH_WRITE_CLOCK_SKEW_MS,
): PostWriteHandoff | null {
  const state = readPostWriteHandoffState(requestOrUrl, nowMs, maxAgeMs, clockSkewMs);
  return state.kind === "valid" ? state.handoff : null;
}

export function evaluatePostWriteHandoff<T>(
  options: Readonly<{
    request: Request | string | URL;
    data: T;
    isSatisfied: (data: T, handoff: PostWriteHandoff) => boolean;
    nowMs?: number;
    maxAgeMs?: number;
    clockSkewMs?: number;
  }>,
): PostWriteHandoffEvaluation<T> {
  const state = readPostWriteHandoffState(options.request, options.nowMs, options.maxAgeMs, options.clockSkewMs);
  if (state.kind !== "valid") {
    return {
      kind: "not-applicable",
      data: options.data,
      state,
    };
  }

  const base = {
    data: options.data,
    handoff: state.handoff,
    receipt: state.receipt,
    ageMs: state.ageMs,
  };
  return options.isSatisfied(options.data, state.handoff)
    ? { kind: "satisfied", ...base }
    : { kind: "pending", ...base };
}

export function recoverFreshWriteReadError<T>(options: FreshWriteReadRecoveryOptions<T>): T | null {
  const classification = classifyFreshWriteReadError(options);
  if (classification.transient) {
    return options.recoverTransient(classification);
  }

  return options.recoverPermanent?.(classification) ?? null;
}

function postWriteHandoffFailureReason(
  state: Exclude<PostWriteHandoffState, { kind: "valid" | "missing" }>,
): "semantic-handoff-expired" | "semantic-handoff-malformed" | "semantic-handoff-invalid" {
  if (state.kind === "malformed") {
    return "semantic-handoff-malformed";
  }

  return state.freshWrite.kind === "expired" ? "semantic-handoff-expired" : "semantic-handoff-invalid";
}

export async function loadAfterWrite<T>(options: LoadAfterWriteOptions<T>): Promise<LoadAfterWriteResult<T>> {
  const nowMs = options.nowMs ?? Date.now;
  let data: T;

  try {
    data = await loadFreshlyWrittenResource({
      request: options.request,
      load: options.load,
      isNotFound: options.isNotFound,
      waitForFreshness: options.waitForFreshness,
      retryDelaysMs: options.retryDelaysMs,
      nowMs,
      maxAgeMs: options.maxAgeMs,
    });
  } catch (error) {
    const classification = classifyFreshWriteReadError({
      request: options.request,
      error,
      nowMs: nowMs(),
      maxAgeMs: options.maxAgeMs,
      getStatus: options.getStatus,
      getErrorCode: options.getErrorCode,
      getBody: options.getBody,
    });
    const recoveryKind = postWriteRecoveryKindForFreshWriteReadError(classification);

    return classification.transient
      ? {
          kind: "pending",
          reason: "fresh-write-read-transient",
          data: null,
          recoveryKind,
          classification,
          error,
        }
      : {
          kind: "permanent-failure",
          reason: "fresh-write-read-permanent",
          recoveryKind,
          classification,
          error,
        };
  }

  if (!options.isHandoffSatisfied) {
    return { kind: "data", data, handoff: null };
  }

  const handoff = evaluatePostWriteHandoff({
    request: options.request,
    data,
    isSatisfied: options.isHandoffSatisfied,
    nowMs: nowMs(),
    maxAgeMs: options.maxAgeMs,
    clockSkewMs: options.clockSkewMs,
  });

  if (handoff.kind === "satisfied" || handoff.kind === "not-applicable") {
    if (handoff.kind === "not-applicable" && handoff.state.kind !== "missing") {
      const recoveryKind = postWriteRecoveryKindForHandoffState(handoff.state);
      return {
        kind: "permanent-failure",
        reason: postWriteHandoffFailureReason(handoff.state),
        recoveryKind,
        state: handoff.state,
      };
    }

    return { kind: "data", data, handoff };
  }

  return {
    kind: "pending",
    reason: "semantic-handoff-pending",
    data,
    recoveryKind: "pending-projection",
    handoff,
  };
}

export function classifyPostWriteDestinationResult<T>(
  result: LoadAfterWriteResult<T>,
): PostWriteDestinationResultClassification<T> {
  switch (result.kind) {
    case "data":
      return {
        kind: "data",
        data: result.data,
        result,
      };
    case "pending":
      return {
        kind: "recover",
        reason: result.reason,
        recoveryKind: result.recoveryKind,
        data: result.data,
        result,
      };
    case "permanent-failure":
      return {
        kind: "pass-through",
        reason: result.reason,
        recoveryKind: result.recoveryKind,
        result,
      };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadFreshlyWrittenResource<T>(
  options: Readonly<{
    request: Request;
    load: () => Promise<T>;
    isNotFound: (error: unknown) => boolean;
    waitForFreshness?: (receipt: FreshWriteReceipt) => Promise<void>;
    retryDelaysMs?: readonly number[];
    nowMs?: () => number;
    maxAgeMs?: number;
  }>,
): Promise<T> {
  const nowMs = options.nowMs ?? Date.now;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FRESH_WRITE_RETRY_DELAYS_MS;
  const readReceipt = () => readFreshWriteToken(options.request, nowMs(), options.maxAgeMs);
  const receipt = readReceipt();

  if (receipt && options.waitForFreshness) {
    await options.waitForFreshness(receipt);
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await options.load();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (!options.isNotFound(error) || delayMs === undefined || !readReceipt()) {
        throw error;
      }

      await delay(delayMs);
      const retryReceipt = readReceipt();
      if (retryReceipt && options.waitForFreshness) {
        await options.waitForFreshness(retryReceipt);
      }
    }
  }
}

export function readApiErrorMessage(body: unknown, fallback = "Request failed."): string {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return fallback;
  }

  const error = (body as { error: unknown }).error;
  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return fallback;
}
