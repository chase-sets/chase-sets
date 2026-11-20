import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { CountSpend } from "../../../scope-sync-batches/domain/count-acquisition";
import {
  buildCatalogIntegrationControlPlaneOverview,
  type parseCatalogIntegrationControlPlaneOverviewAudience,
} from "../admin/admin-control-plane-overview";
import type { CatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import { listCatalogProviderProfileVersionReviews } from "../providers/provider-profile-review";
import type { CatalogIntegrationEngineServices, IntegrationJobServices } from "../runtime";
import type { ProviderSendWindowServices } from "../source-observation-runtime-contracts";

export type CatalogIntegrationControlPlaneOverviewServices = Pick<
  CatalogIntegrationEngineServices,
  "getCatalogIntegrationControlPlaneReadiness"
> &
  Pick<
    IntegrationJobServices,
    "listRecentIntegrationJobs" | "listActiveIntegrationJobs" | "listActiveIntegrationJobSnapshot"
  >;

export type CatalogIntegrationControlPlaneOverviewSources = Readonly<{
  services: CatalogIntegrationControlPlaneOverviewServices;
  profileVersions?: CatalogProviderIntegrationProfileVersionStore;
  readCountSpend?: () => Promise<readonly CountSpend[]>;
}>;

// The full or daily control-plane overview, assembled once for the overview route
// and the workbench surface read so both answer with the same facts.
export async function loadCatalogIntegrationControlPlaneOverview(
  sources: CatalogIntegrationControlPlaneOverviewSources,
  input: Readonly<{
    context: CatalogAuthoringEnv["Variables"]["context"];
    audience: ReturnType<typeof parseCatalogIntegrationControlPlaneOverviewAudience>;
    // The route reports a runtime without a send window as unavailable.
    providerSendWindow:
      | Awaited<ReturnType<ProviderSendWindowServices["getProviderSendWindow"]>>
      | { state: "unavailable" };
  }>,
) {
  const { services, profileVersions, readCountSpend } = sources;
  const [readiness, profiles, recentJobs, activeJobs] = await Promise.all([
    services.getCatalogIntegrationControlPlaneReadiness(),
    profileVersions ? listCatalogProviderProfileVersionReviews(profileVersions) : Promise.resolve([]),
    services.listRecentIntegrationJobs({ context: input.context }),
    services.listActiveIntegrationJobSnapshot
      ? services.listActiveIntegrationJobSnapshot({ context: input.context })
      : (services.listActiveIntegrationJobs?.({ context: input.context }) ?? Promise.resolve([])).then((items) => ({
          items,
          completeness: "incomplete" as const,
        })),
  ]);

  return {
    ...buildCatalogIntegrationControlPlaneOverview({
      readiness,
      profiles,
      activeJobs,
      recentJobs,
      audience: input.audience,
      countSpend: await readCountSpend?.(),
    }),
    providerSendWindow: input.providerSendWindow,
  };
}
