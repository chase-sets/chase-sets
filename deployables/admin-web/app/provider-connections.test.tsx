import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { mountApiRouters, resolveModuleApiMounts } from "@chase-sets/bounded-context-runtime";
import { createTestApp } from "@chase-sets/bounded-context-runtime/test-support";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCatalogProviderConnectionsReadSource } from "@chase-sets/catalog/server";
import { createChannelConnectionsOperatorReadSourceFromReadModel } from "@chase-sets/channels/server";
import { module as platformOperations } from "@chase-sets/platform-operations";
import ProviderConnectionsRoute, { loader } from "@chase-sets/platform-operations/routes/admin/provider-connections";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import { webContextRegistry } from "./generated/web-context-registry";

const auth = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@chase-sets/platform-runtime/auth", () => ({ resolveActorFromAuthApi: auth.resolve }));

const admin: ResolvedActor = {
  sessionId: "synthetic-session",
  tenantId: "synthetic-tenant",
  userId: "synthetic-user",
  accountId: "synthetic-platform",
  membershipId: "synthetic-membership",
  roleKey: "platform-admin",
  permissions: ["provider-connections.view"],
};
const old = "2020-01-01T00:00:00.000Z";

function fixture({
  emptyCatalog = false,
  emptyChannels = false,
  rejectCatalog = false,
  missingCatalog = false,
  channelCount = 2,
} = {}) {
  const catalog = createCatalogProviderConnectionsReadSource(() => ({
    getCatalogIntegrationControlPlaneReadiness: async () => {
      if (rejectCatalog) throw new Error("MUST-NOT-CROSS provider error");
      return {
        generatedAt: old,
        rolloutControls: { generatedAt: old, controls: [] },
        units: emptyCatalog
          ? []
          : [
              {
                unitKey: "synthetic-unit",
                providerKey: "synthetic-provider",
                displayName: "Synthetic",
                productDomain: "cards",
                productForm: "single",
                ingestionPurpose: null,
                profileVersion: "v1",
                semanticReadiness: "ready",
                credentialReadiness: "blocked",
                credentialReadinessState: "unknown",
                credentialRequirement: "required",
                credentialDiagnosticCode: null,
                transportReadiness: "ready",
                fixtureValidationStatus: "ready",
                dryRunStatus: "completed",
                observationFacts: 0,
                diagnosticCounts: { info: 0, warning: 0, error: 0 },
                diagnostics: [],
                latestDiagnosticText: "MUST-NOT-CROSS",
                dryRunEvidence: [
                  {
                    externalKey: "MUST-NOT-CROSS",
                    sourceUrl: null,
                    sourceHash: null,
                    normalizedFacts: { secret: "MUST-NOT-CROSS" },
                  },
                ],
              },
            ],
      };
    },
  }));
  const query = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql, values = []) => {
    if (sql.includes("channel_connection_health"))
      return {
        rows: (values[0] as string[]).map((id, index) => ({
          connection_id: id,
          state: "healthy",
          observed_at: index === 0 ? old : null,
        })),
      };
    if (emptyChannels) return { rows: [] };
    const start = values[0] ? Number(String(values[0]).split("-").at(-1)) + 1 : 0;
    return {
      rows: Array.from({ length: Math.min(Number(values[1] ?? 1), Math.max(0, channelCount - start)) }, (_, index) => ({
        connection_id: `synthetic-connection-${String(start + index).padStart(4, "0")}`,
        account_id: `synthetic-seller-${(start + index) % 2}`,
        provider_key: "ebay",
        status: "disconnected",
        credential_reference: "MUST-NOT-CROSS",
      })),
    };
  });
  const pool: PgTransactionalPool = {
    query: vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
  };
  const services = platformOperations.createServices(pool, {
    providerConnectionsCrossContext: {
      ...(missingCatalog ? {} : { catalog }),
      channels: createChannelConnectionsOperatorReadSourceFromReadModel({ query }),
    },
  });
  const api = createTestApp<AuthenticatedApiEnv>({
    actor: null,
    context: null,
    routes(app) {
      app.use("*", async (c, next) => {
        const actor = await auth.resolve();
        if (actor) c.set("actor", actor);
        await next();
      });
      mountApiRouters(app, resolveModuleApiMounts(platformOperations, services));
    },
  });
  return { api, query };
}

async function route(pending = false) {
  let loaded!: (data: Awaited<ReturnType<typeof loader>>) => void;
  const loaderCompleted = new Promise<Awaited<ReturnType<typeof loader>>>((resolve) => {
    loaded = resolve;
  });
  const router = createMemoryRouter(
    [
      {
        path: "/platform/provider-connections",
        loader: async (args) => {
          const data = await loader(args);
          loaded(data);
          return data;
        },
        Component: ProviderConnectionsRoute,
      },
    ],
    { initialEntries: ["/platform/provider-connections"] },
  );
  await act(async () => {
    render(<RouterProvider router={router} />);
    const data = await loaderCompleted;
    if (!pending) await data.snapshot;
  });
  return router;
}

beforeEach(() => {
  auth.resolve.mockResolvedValue(admin);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider connections real loader and owner exports", () => {
  it("renders both owners and scopes, unknown/old/absent observations, and only registered Catalog actions", async () => {
    const { api } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => api.request(String(input), init)),
    );
    await route();
    await screen.findAllByText("synthetic-provider");
    expect(screen.getAllByText("Seller account synthetic-seller-0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Platform").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Too old to assess readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Observation time unknown").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Age shown; no freshness threshold").length).toBeGreaterThan(0);
    expect(screen.queryByText("Fresh")).toBeNull();
    expect(screen.getAllByText("Read-only; no operator action").length).toBeGreaterThan(0);
    const records = resolveWebHostRouteConfigRecords(webContextRegistry, "admin-web");
    const catalogRoute = records.find((record) => record.routeId === "provider-detail");
    expect(catalogRoute).toBeDefined();
    expect(catalogRoute?.contextName).toBe("catalog");
    const links = screen.getAllByRole("link");
    for (const link of links)
      expect(link.getAttribute("href")).toBe(
        `/${catalogRoute?.routePath.replace(":providerKey", "synthetic-provider")}`,
      );
    expect(document.body.textContent).not.toMatch(/Pricing|MUST-NOT-CROSS/);
    expect(document.querySelector('a[href*="account/"]')).toBeNull();
    const payload = await (await api.request("/api/platform/provider-connections")).text();
    expect(payload).not.toMatch(/MUST-NOT-CROSS|credential_reference|dryRunEvidence/);
  });

  it.each([{ emptyCatalog: true }, { emptyChannels: true }, { rejectCatalog: true }, { missingCatalog: true }])(
    "keeps the other home visible for %j",
    async (options) => {
      const { api } = fixture(options);
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => api.request(String(input), init)),
      );
      await route();
      if ("emptyChannels" in options) {
        await screen.findAllByText("No channel connections");
        expect(screen.getAllByText("synthetic-provider").length).toBeGreaterThan(0);
      } else {
        await screen.findAllByText("emptyCatalog" in options ? "No Catalog providers" : "Connections unavailable");
        expect(screen.getAllByText("ebay").length).toBeGreaterThan(0);
      }
    },
  );

  it("visibly renders pending sections and an incomplete Channels list", async () => {
    const { api } = fixture({ channelCount: 1001 });
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    await route(true);
    await screen.findAllByText("Loading connections...");
    await act(async () => {
      release(await api.request("/api/platform/provider-connections"));
    });
    await screen.findByText("Showing the first 1,000 connections. More connections exist; this list is incomplete.");
  });

  it.each([
    ["unauthenticated", null, 401],
    ["seller", { ...admin, roleKey: "owner", permissions: ["channels.view"] }, 403],
    ["unprivileged", { ...admin, permissions: [] }, 403],
    ["non-admin with grant", { ...admin, roleKey: "owner" }, 403],
  ] as const)("denies %s at both route and API before reading owners", async (_name, actor, status) => {
    auth.resolve.mockResolvedValue(actor);
    const { api, query } = fixture();
    await expect(
      loader({
        request: new Request("http://localhost/platform/provider-connections"),
        params: {},
        context: {},
        url: new URL("http://localhost/platform/provider-connections"),
        pattern: "/platform/provider-connections",
      }),
    ).rejects.toMatchObject({ status });
    expect((await api.request("/api/platform/provider-connections")).status).toBe(status);
    expect(query).not.toHaveBeenCalled();
  });
});
