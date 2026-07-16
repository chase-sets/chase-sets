import type { MetaFunction } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { t } from "@chase-sets/localization";
import { ProjectionOperationsReferencePage } from "../../features/projection-operations/ui/projection-operations-reference-page";
import { projectionSelectionHref } from "../../features/projection-operations/ui/projection-operations-filters";
import {
  action as projectionOperationsAction,
  loader as projectionOperationsLoader,
  useAdminActorPermissions,
} from "./projection-operations";

const routeKey = "platformOperations.projectionOperations";

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.referenceMetaTitle`) }];
export const loader = projectionOperationsLoader;
export const action = projectionOperationsAction;

export default function ProjectionOperationsReferenceRoute() {
  const { data, filters, wakeStatus } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <ProjectionOperationsReferencePage
      data={data}
      filters={filters}
      wakeStatus={wakeStatus}
      actorPermissions={useAdminActorPermissions()}
      onSelectedDetailClose={() => navigate(projectionSelectionHref("/platform/projections/reference", filters))}
    />
  );
}
