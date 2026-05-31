import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { t } from "@chase-sets/localization";
import { loadReleaseControlsSnapshot } from "../../features/release-controls/api/client";
import { ReleaseControlsPage } from "../../features/release-controls/ui/release-controls-page";

const routeKey = "platformOperations.releaseControls";

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export function loader({ request }: LoaderFunctionArgs) {
  return {
    data: loadReleaseControlsSnapshot(request),
  };
}

export default function ReleaseControlsRoute() {
  const { data } = useLoaderData<typeof loader>();
  return <ReleaseControlsPage data={data} />;
}
