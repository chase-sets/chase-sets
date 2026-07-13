import type { LoaderFunctionArgs } from "react-router";
import type { ProviderRefreshSchedulePanelItem } from "../../../features/provider-scope-discovery/ui/provider-refresh-schedule-panel";
import { createCatalogRequestApiClient } from "../../request-support/api-client";
import { loadProvidersSurface } from "./integrations-loader-support";

// Provider profiles and readiness surface route loader
// (/admin/integrations/providers). Loads the shared baseline plus the selected
// provider profile authoring model and computes only the profile-authoring and
// validation-readiness slices its surface renders. The scheduled source-option
// refresh schedule loads fail-soft alongside: a missing endpoint or a
// transient failure must never break the providers surface, so it resolves to
// null and the panel simply does not render.
export async function loader(args: LoaderFunctionArgs) {
  const [surfaceData, providerRefreshSchedules] = await Promise.all([
    loadProvidersSurface(args),
    loadProviderRefreshSchedules(args.request),
  ]);

  return { ...surfaceData, providerRefreshSchedules };
}

async function loadProviderRefreshSchedules(
  request: Request,
): Promise<readonly ProviderRefreshSchedulePanelItem[] | null> {
  const api = createCatalogRequestApiClient(request);
  if (typeof api.listCatalogProviderRefreshSchedules !== "function") {
    return null;
  }

  try {
    const response = await api.listCatalogProviderRefreshSchedules<{
      items: readonly ProviderRefreshSchedulePanelItem[];
    }>();
    return response.items;
  } catch {
    return null;
  }
}
