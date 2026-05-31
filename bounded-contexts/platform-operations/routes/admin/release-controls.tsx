import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { useLoaderData } from "react-router";
import { t } from "@chase-sets/localization";
import { loadReleaseControlsSnapshot, normalizeRolloutEnvironment } from "../../features/release-controls/api/client";
import { createPlatformOperationsRequestApiClient } from "../../features/release-controls/api/request-client";
import { ReleaseControlsPage } from "../../features/release-controls/ui/release-controls-page";

const routeKey = "platformOperations.releaseControls";

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export function loader({ request }: LoaderFunctionArgs) {
  return {
    data: loadReleaseControlsSnapshot(request),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createPlatformOperationsRequestApiClient(request);

  if (intent === "set-release-lock") {
    await api.setReleaseLock({
      locked: String(formData.get("releaseAction") ?? "lock") === "lock",
      reason: String(formData.get("releaseReason") ?? ""),
      reference: String(formData.get("releaseReference") ?? ""),
    });
    return redirect("/operations/release-controls");
  }

  if (intent === "set-rollout-policy") {
    await api.setRolloutPolicy(String(formData.get("rolloutFeatureKey") ?? ""), {
      environment: normalizeRolloutEnvironment(String(formData.get("rolloutEnvironment") ?? "")),
      percentage: Number(formData.get("rolloutPercentage") ?? 0),
      allowSubjects: String(formData.get("rolloutAllowSubjects") ?? ""),
      optOutSubjects: String(formData.get("rolloutOptOutSubjects") ?? ""),
      killSwitchActive: formData.get("rolloutKillSwitchActive") === "true",
      reason: String(formData.get("releaseReason") ?? ""),
      reference: String(formData.get("releaseReference") ?? ""),
    });
    return redirect("/operations/release-controls");
  }

  return { error: t(`${routeKey}.unknownAction`) };
}

export default function ReleaseControlsRoute() {
  const { data } = useLoaderData<typeof loader>();
  return <ReleaseControlsPage data={data} />;
}
