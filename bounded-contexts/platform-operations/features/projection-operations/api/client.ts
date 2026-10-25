import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import {
  normalizeProjectionOperationsSnapshot,
  type AttentionItem,
  type ProjectionOperationsFilters,
  type ProjectionRepairQueueItem,
  type ProjectionOperationsSnapshot,
} from "../read-model/contracts";
import { normalizeWakeStatusSnapshot, type WakeStatusSnapshot } from "../read-model/wake-status-contracts";

type ProjectionOperationsTriage = Readonly<{
  attentionItems: readonly AttentionItem[];
  repairQueue: readonly ProjectionRepairQueueItem[];
  activeWorkerCount: number;
  staleWorkerCount: number;
}>;

export type ProjectionOperationsConsoleSnapshot = ProjectionOperationsSnapshot & ProjectionOperationsTriage;

export type WakeStatusConsoleSnapshot = WakeStatusSnapshot &
  Readonly<{
    attentionItems: readonly AttentionItem[];
  }>;

export type ProjectionOperationCommandSnapshot =
  | ProjectionOperationsSnapshot
  | Readonly<{ operation: Record<string, unknown> }>
  | Readonly<{ result: { cancelled: boolean } }>;

export async function loadProjectionOperationsConsoleSnapshot(
  request: Request,
): Promise<ProjectionOperationsConsoleSnapshot> {
  const response = await fetchProjectionOperationsResponse(request);

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  const body: unknown = await response.json();
  const snapshot = normalizeProjectionOperationsSnapshot(body);
  const triage = parseProjectionOperationsTriage(body);
  return { ...snapshot, ...triage };
}

export async function loadWakeStatusConsoleSnapshot(request: Request): Promise<WakeStatusConsoleSnapshot | null> {
  // Wake attention degrades instead of failing the whole console when the API
  // response predates the field or contains malformed derived data.
  try {
    const response = await fetchWakeStatusResponse(request);

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    const attentionItems = parseAttentionItems(body);
    if (!attentionItems) {
      return null;
    }

    return { ...normalizeWakeStatusSnapshot(body), attentionItems };
  } catch {
    return null;
  }
}

export function readProjectionOperationsFilters(request: Request): ProjectionOperationsFilters {
  const url = new URL(request.url);

  return {
    state: url.searchParams.get("state") ?? "",
    contextName: url.searchParams.get("contextName") ?? "",
    projectionName: url.searchParams.get("projectionName") ?? "",
    search: url.searchParams.get("search") ?? "",
    selected: url.searchParams.get("selected") ?? "",
  };
}

export async function refreshProjectionStatus(request: Request) {
  const snapshot = await postProjectionOperation(request, ["refresh"]);
  return normalizeProjectionOperationsSnapshot(snapshot);
}

export async function retryBlockedStream(
  request: Request,
  input: Readonly<{ projectionKey: string; streamId: string }>,
) {
  return postProjectionOperation(request, [input.projectionKey, "blocked-streams", input.streamId, "retry"]);
}

export async function rebuildProjectionGroup(
  request: Request,
  input: Readonly<{ contextName: string; projectionName: string }>,
) {
  return postProjectionOperation(request, ["groups", input.contextName, input.projectionName, "rebuild"], {
    confirm: "rebuild",
  });
}

export async function rebuildProjectionContext(request: Request, input: Readonly<{ contextName: string }>) {
  return postProjectionOperation(request, ["groups", input.contextName, "rebuild"], {
    confirm: "rebuild-all",
  });
}

export async function cancelProjectionOperation(request: Request, input: Readonly<{ operationId: string }>) {
  return postProjectionOperation(request, ["operations", input.operationId, "cancel"]);
}

function resolveProjectionOperationsApiUrl(request: Request) {
  return new URL(resolveRequestApiBaseUrl(request, "/api/platform/projections"));
}

function fetchProjectionOperationsResponse(request: Request) {
  return fetch(resolveProjectionOperationsApiUrl(request), {
    headers: createForwardedAuthHeaders(request),
  });
}

function fetchWakeStatusResponse(request: Request) {
  const url = resolveProjectionOperationsApiUrl(request);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/wake-status`;
  return fetch(url, {
    headers: createForwardedAuthHeaders(request),
  });
}

function parseProjectionOperationsTriage(body: unknown): ProjectionOperationsTriage {
  if (!isRecord(body)) {
    throw malformedProjectionTriageResponse();
  }

  const attentionItems = parseAttentionItems(body);
  const repairQueue = parseObjectArray<ProjectionRepairQueueItem>(body.repairQueue);
  const activeWorkerCount = parseNonNegativeInteger(body.activeWorkerCount);
  const staleWorkerCount = parseNonNegativeInteger(body.staleWorkerCount);

  if (!attentionItems || !repairQueue || activeWorkerCount === null || staleWorkerCount === null) {
    throw malformedProjectionTriageResponse();
  }

  return { attentionItems, repairQueue, activeWorkerCount, staleWorkerCount };
}

function parseAttentionItems(body: unknown): AttentionItem[] | null {
  return isRecord(body) ? parseObjectArray<AttentionItem>(body.attentionItems) : null;
}

function parseObjectArray<T extends Record<string, unknown>>(value: unknown): T[] | null {
  return Array.isArray(value) && value.every((item): item is T => isRecord(item)) ? value : null;
}

function parseNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedProjectionTriageResponse() {
  return new Response("Malformed projection triage response", { status: 502 });
}

async function postProjectionOperation(
  request: Request,
  segments: readonly string[],
  body: Record<string, unknown> = {},
): Promise<ProjectionOperationCommandSnapshot> {
  const url = resolveProjectionOperationsApiUrl(request);
  for (const segment of segments) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(segment)}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: createForwardedAuthHeaders(request, {
      "content-type": "application/json",
    }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as ProjectionOperationCommandSnapshot;
}
