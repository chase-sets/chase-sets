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
const DEFAULT_FRESH_WRITE_MAX_AGE_MS = 30_000;
const DEFAULT_FRESH_WRITE_RETRY_DELAYS_MS = [75, 150, 300, 600, 1_000] as const;
export const CHASE_SETS_COMMIT_RECEIPT_HEADER = "Chase-Sets-Commit-Receipt";
export const CHASE_SETS_READ_AFTER_WRITE_HEADER = "Chase-Sets-Read-After-Write";
export const CHASE_SETS_READ_TARGET_CONTEXT_HEADER = "Chase-Sets-Read-Target-Context";

export type FreshWriteReceipt = Readonly<{
  observedAtMs: number;
  commitPosition?: string;
  sources: readonly SourceCommitPosition[];
}>;

export type FreshWriteReadErrorKind =
  | "transient-not-found"
  | "transient-projection-timeout"
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

type MetadataCarrier = {
  [RESPONSE_METADATA]?: ResponseMetadata;
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

  Object.defineProperty(body, RESPONSE_METADATA, {
    value: {
      consistency: readResponseConsistencyMetadata(response),
    } satisfies ResponseMetadata,
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

export function decodeFreshWriteReceipt(
  value: string | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
): FreshWriteReceipt | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!isFreshWriteReceipt(parsed)) {
      return null;
    }

    const observedAtMs = Number(parsed.observedAtMs);
    const ageMs = nowMs - observedAtMs;
    if (ageMs < 0 || ageMs > maxAgeMs) {
      return null;
    }

    return {
      observedAtMs,
      ...(parsed.commitPosition ? { commitPosition: parsed.commitPosition } : {}),
      sources: parsed.sources,
    };
  } catch {
    return null;
  }
}

function consistencyMetadataFromSource(source: unknown): ResponseConsistencyMetadata | null {
  return typeof source === "object" && source !== null && ("commitPosition" in source || "commitPositions" in source)
    ? (source as ResponseConsistencyMetadata)
    : (getResponseMetadata(source)?.consistency ?? null);
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

export function readFreshWriteToken(
  requestOrUrl: Request | string | URL,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_FRESH_WRITE_MAX_AGE_MS,
): FreshWriteReceipt | null {
  const url =
    requestOrUrl instanceof URL
      ? requestOrUrl
      : new URL(typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url, "https://chase-sets.local");
  const token = url.searchParams.get(FRESH_WRITE_PARAM);
  if (!token) {
    return null;
  }

  try {
    if (decodeURIComponent(token).startsWith("{")) {
      return decodeFreshWriteReceipt(token, nowMs, maxAgeMs);
    }
  } catch {
    return null;
  }

  const [encodedPosition, observedAtText] = token.split(".");
  const observedAtMs = Number(observedAtText);
  if (!encodedPosition || !Number.isFinite(observedAtMs)) {
    return null;
  }

  const ageMs = nowMs - observedAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return null;
  }

  return {
    commitPosition: decodeURIComponent(encodedPosition),
    observedAtMs,
    sources: [],
  };
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

  return {
    kind: "fresh-write-unhandled",
    transient: false,
    receipt,
    status,
    errorCode,
  };
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
