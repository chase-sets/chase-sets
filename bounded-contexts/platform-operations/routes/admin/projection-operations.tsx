import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useMatches } from "react-router";
import { t } from "@chase-sets/localization";
import {
  cancelProjectionOperation,
  loadProjectionOperationsSnapshot,
  readProjectionOperationsFilters,
  rebuildProjectionContext,
  rebuildProjectionGroup,
  refreshProjectionStatus,
  retryBlockedStream,
} from "../../features/projection-operations/api/client";
import { ProjectionOperationsPage } from "../../features/projection-operations/ui/projection-operations-page";

const routeKey = "platformOperations.projectionOperations";

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    data: await loadProjectionOperationsSnapshot(request),
    filters: readProjectionOperationsFilters(request),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "refresh-status") {
    await refreshProjectionStatus(request);
  } else if (intent === "retry-stream") {
    await retryBlockedStream(request, {
      projectionKey: String(formData.get("projectionKey") ?? ""),
      streamId: String(formData.get("streamId") ?? ""),
    });
  } else if (intent === "rebuild-group") {
    await rebuildProjectionGroup(request, {
      contextName: String(formData.get("contextName") ?? ""),
      projectionName: String(formData.get("projectionName") ?? ""),
    });
  } else if (intent === "rebuild-context") {
    await rebuildProjectionContext(request, {
      contextName: String(formData.get("contextName") ?? ""),
    });
  } else if (intent === "cancel-operation") {
    await cancelProjectionOperation(request, {
      operationId: String(formData.get("operationId") ?? ""),
    });
  }

  return redirect("/platform/projections");
}

export default function ProjectionOperationsRoute() {
  const { data, filters } = useLoaderData<typeof loader>();
  return <ProjectionOperationsPage data={data} filters={filters} actorPermissions={useAdminActorPermissions()} />;
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
