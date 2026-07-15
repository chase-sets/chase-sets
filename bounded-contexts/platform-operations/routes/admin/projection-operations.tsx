import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useMatches, useRevalidator } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { t } from "@chase-sets/localization";
import {
  cancelProjectionOperation,
  loadProjectionOperationsSnapshot,
  loadWakeStatusSnapshot,
  readProjectionOperationsFilters,
  rebuildProjectionContext,
  rebuildProjectionGroup,
  refreshProjectionStatus,
  retryBlockedStream,
} from "../../features/projection-operations/api/client";
import { ProjectionOperationsPage } from "../../features/projection-operations/ui/projection-operations-page";

const routeKey = "platformOperations.projectionOperations";

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

function currentRoutePath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const [data, wakeStatus] = await Promise.all([
    loadProjectionOperationsSnapshot(request),
    loadWakeStatusSnapshot(request),
  ]);

  return {
    data,
    wakeStatus,
    filters: readProjectionOperationsFilters(request),
  };
}

const afterProjectionOperation = (request: Request) => formActionRedirect(null, currentRoutePath(request));

export const action = defineFormAction({
  intents: {
    "refresh-status": async ({ request }) => {
      await refreshProjectionStatus(request);
      return afterProjectionOperation(request);
    },
    "retry-stream": async ({ request, formData }) => {
      await retryBlockedStream(request, {
        projectionKey: String(formData.get("projectionKey") ?? ""),
        streamId: String(formData.get("streamId") ?? ""),
      });
      return afterProjectionOperation(request);
    },
    "rebuild-group": async ({ request, formData }) => {
      await rebuildProjectionGroup(request, {
        contextName: String(formData.get("contextName") ?? ""),
        projectionName: String(formData.get("projectionName") ?? ""),
      });
      return afterProjectionOperation(request);
    },
    "rebuild-context": async ({ request, formData }) => {
      await rebuildProjectionContext(request, { contextName: String(formData.get("contextName") ?? "") });
      return afterProjectionOperation(request);
    },
    "cancel-operation": async ({ request, formData }) => {
      await cancelProjectionOperation(request, { operationId: String(formData.get("operationId") ?? "") });
      return afterProjectionOperation(request);
    },
  },
  onUnknownIntent: ({ request }) => afterProjectionOperation(request),
});

export default function ProjectionOperationsRoute() {
  const { data, filters, wakeStatus } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <ProjectionOperationsPage
      data={data}
      filters={filters}
      wakeStatus={wakeStatus}
      actorPermissions={useAdminActorPermissions()}
      onOperationTerminal={revalidator.revalidate}
    />
  );
}

function useAdminActorPermissions() {
  for (const match of useMatches()) {
    if (match.data && typeof match.data === "object" && "actor" in match.data) {
      const actor = (match.data as { actor?: { permissions?: readonly string[] } }).actor;
      return actor?.permissions ?? [];
    }
  }

  return [];
}
