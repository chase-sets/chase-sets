import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import {
  normalizeProjectionOperationsSnapshot,
  type ProjectionOperationsFilters,
  type ProjectionOperationsSnapshot,
} from "../read-model/contracts";
import { normalizeWakeStatusSnapshot, type WakeStatusSnapshot } from "../read-model/wake-status-contracts";

export type ProjectionOperationCommandSnapshot =
  | ProjectionOperationsSnapshot
  | Readonly<{ operation: Record<string, unknown> }>
  | Readonly<{ result: { cancelled: boolean } }>;

export async function loadProjectionOperationsSnapshot(request: Request): Promise<ProjectionOperationsSnapshot> {
  const response = await fetch(resolveProjectionOperationsApiUrl(request), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return normalizeProjectionOperationsSnapshot(await response.json());
}

export async function loadWakeStatusSnapshot(request: Request): Promise<WakeStatusSnapshot | null> {
  const url = resolveProjectionOperationsApiUrl(request);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/wake-status`;

  // Wake attention degrades instead of failing the whole console: an API host
  // that predates the endpoint (deploy skew) or a transient error renders as
  // an explicit unavailable state.
  try {
    const response = await fetch(url, {
      headers: createForwardedAuthHeaders(request),
    });

    if (!response.ok) {
      return null;
    }

    return normalizeWakeStatusSnapshot(await response.json());
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
