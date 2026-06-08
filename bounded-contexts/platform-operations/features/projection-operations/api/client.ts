import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import {
  normalizeProjectionOperationsSnapshot,
  type ProjectionOperationsFilters,
  type ProjectionOperationsSnapshot,
} from "../read-model/contracts";

export async function loadProjectionOperationsSnapshot(request: Request): Promise<ProjectionOperationsSnapshot> {
  const response = await fetch(resolveProjectionOperationsApiUrl(request), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return normalizeProjectionOperationsSnapshot(await response.json());
}

export function readProjectionOperationsFilters(request: Request): ProjectionOperationsFilters {
  const url = new URL(request.url);

  return {
    tab: url.searchParams.get("tab") ?? "",
    state: url.searchParams.get("state") ?? "",
    contextName: url.searchParams.get("contextName") ?? "",
    projectionName: url.searchParams.get("projectionName") ?? "",
    search: url.searchParams.get("search") ?? "",
    selected: url.searchParams.get("selected") ?? "",
  };
}

export async function refreshProjectionStatus(request: Request) {
  await postProjectionOperation(request, ["refresh"]);
}

export async function retryBlockedStream(
  request: Request,
  input: Readonly<{ projectionKey: string; streamId: string }>,
) {
  await postProjectionOperation(request, [input.projectionKey, "blocked-streams", input.streamId, "retry"]);
}

export async function rebuildProjectionGroup(
  request: Request,
  input: Readonly<{ contextName: string; projectionName: string }>,
) {
  await postProjectionOperation(request, ["groups", input.contextName, input.projectionName, "rebuild"], {
    confirm: "rebuild",
  });
}

export async function rebuildProjectionContext(request: Request, input: Readonly<{ contextName: string }>) {
  await postProjectionOperation(request, ["groups", input.contextName, "rebuild"], {
    confirm: "rebuild-all",
  });
}

export async function cancelProjectionOperation(request: Request, input: Readonly<{ operationId: string }>) {
  await postProjectionOperation(request, ["operations", input.operationId, "cancel"]);
}

function resolveProjectionOperationsApiUrl(request: Request) {
  return new URL(resolveRequestApiBaseUrl(request, "/api/platform/projections"));
}

async function postProjectionOperation(
  request: Request,
  segments: readonly string[],
  body: Record<string, unknown> = {},
) {
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
}
