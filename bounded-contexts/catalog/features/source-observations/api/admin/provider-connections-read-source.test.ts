import { describe, expect, it, vi } from "vitest";
import { createCatalogProviderConnectionsReadSource } from "../../../../server";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import { createScrydexOnePieceProviderAdapter } from "../provider-adapters/scrydex-one-piece";
import { buildCatalogIntegrationControlPlaneReadiness } from "../governance/catalog-integration-control-plane-readiness";
import { buildCatalogIntegrationControlPlaneOverview } from "./admin-control-plane-overview";

describe("Catalog provider connections source", () => {
  it("reuses one readiness read and never increases overview provider calls", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("No live provider calls"));
    const adapter = createScrydexOnePieceProviderAdapter({ fetch });
    const transport = vi.spyOn(adapter, "getTransportDiagnostics");
    const registry = new ProviderAdapterRegistry([adapter]);
    const readiness = await buildCatalogIntegrationControlPlaneReadiness(registry);
    const overview = buildCatalogIntegrationControlPlaneOverview({ readiness, profiles: [], activeJobs: [] });
    const overviewCalls = transport.mock.calls.length;
    transport.mockClear();
    const getCatalogIntegrationControlPlaneReadiness = vi.fn(async () => {
      const result = await buildCatalogIntegrationControlPlaneReadiness(registry);
      return { ...result, generatedAt: "2020-01-01T00:00:00.000Z" };
    });
    const source = createCatalogProviderConnectionsReadSource(() => ({ getCatalogIntegrationControlPlaneReadiness }));
    expect(getCatalogIntegrationControlPlaneReadiness).not.toHaveBeenCalled();
    const result = await source();
    expect(getCatalogIntegrationControlPlaneReadiness).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.length).toBeLessThanOrEqual(overviewCalls);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.rows).toHaveLength(overview.providerReadiness.providers.length);
    expect(result.rows[0]).toMatchObject({
      provider: "scrydex",
      credentialReadiness: "missing",
      observedAt: "2020-01-01T00:00:00.000Z",
      destination: { routeId: "provider-detail", href: "/catalog/providers/scrydex" },
    });
    expect(Object.keys(result.rows[0]).sort()).toEqual([
      "accountId",
      "capability",
      "credentialReadiness",
      "destination",
      "freshness",
      "health",
      "id",
      "observedAt",
      "owner",
      "provider",
    ]);
  });

  it("fails closed when the lazy runtime is missing", async () => {
    await expect(createCatalogProviderConnectionsReadSource(() => undefined)()).rejects.toThrow("unavailable");
  });
});
