import type { CatalogServices } from "../../../../support/authoring-support/services";
import { buildProviderReadiness, buildCatalogProviderDetailDestination } from "./admin-control-plane-overview";
import { catalogAdminControlPlaneReadModelSlos } from "./admin-control-plane-read-model-slos";

export function createCatalogProviderConnectionsReadSource(
  services: () => Pick<CatalogServices["sourceObservations"], "getCatalogIntegrationControlPlaneReadiness"> | undefined,
) {
  return async () => {
    const source = services();
    if (!source) throw new Error("Catalog provider connections source unavailable");
    const readiness = await source.getCatalogIntegrationControlPlaneReadiness();
    const freshness = catalogAdminControlPlaneReadModelSlos.find(
      (slo) => slo.key === "provider-transport-readiness-summary",
    )?.freshness;
    if (!freshness) throw new Error("Catalog provider connections contract unavailable");
    return {
      complete: true,
      rows: buildProviderReadiness(readiness.units).map((provider) => ({
        id: provider.providerKey,
        provider: provider.providerKey,
        capability: "catalog-integration" as const,
        owner: "catalog" as const,
        accountId: null,
        credentialReadiness: provider.credentialReadinessState,
        health: provider.readiness,
        observedAt: readiness.generatedAt,
        freshness: {
          freshWithinSeconds: freshness.freshWithinSeconds,
          staleAfterSeconds: freshness.staleAfterSeconds,
          unavailableAfterSeconds: freshness.unavailableAfterSeconds,
        },
        destination: buildCatalogProviderDetailDestination(provider.providerKey),
      })),
    };
  };
}
