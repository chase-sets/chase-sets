import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerDetailAction } from "./provider-detail-action";
import { loadProviderDetail } from "./provider-detail-loader";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../../features/source-observations/ui/primary-workbench-read-model";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../authoring-support/api";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createCatalogApiClient } from "../../shell-support/api/client";
import {
  integrationJobRoutes,
  type IntegrationJobRouteServices,
} from "../../../features/source-observations/api/route-modules/integration-job-routes";
import { SourceObservationIntegrationJobLifecycleCommandError } from "../../../features/source-observations/api/source-observation-runtime-contracts";

const { mockCreateCatalogRequestApiClient, mockLoadHealthSurface, mockResolveActorFromAuthApi } = vi.hoisted(() => ({
  mockCreateCatalogRequestApiClient: vi.fn(),
  mockLoadHealthSurface: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
}));

vi.mock("@chase-sets/platform-runtime/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-runtime/auth")>()),
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

vi.mock("../../request-support/api-client", async () => {
  const { withCatalogSurfaceReads } = await vi.importActual<
    typeof import("../../../features/source-observations/tests/integrations-surface-read-test-client")
  >("../../../features/source-observations/tests/integrations-surface-read-test-client");
  return {
    createCatalogRequestApiClient: (request: Request) =>
      withCatalogSurfaceReads(mockCreateCatalogRequestApiClient(request), request),
  };
});

vi.mock("./integrations-loader-support", () => ({
  loadHealthSurface: mockLoadHealthSurface,
}));

describe("provider detail route support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadHealthSurface.mockResolvedValue({
      readModel: { kind: "provider-detail" },
      requestUrl: "https://admin.example/catalog/providers/tcgdex",
      commandFeedback: null,
      providerRefreshSchedules: [schedule("api-answered-provider")],
      operatorSession: false,
      operatorSessionActorKey: null,
    });
  });

  it("passes the original path and query and API answers through without seeding or schedule reads", async () => {
    const listCatalogProviderRefreshSchedules = vi.fn().mockResolvedValue({
      items: [schedule("tcgdex"), schedule("scryfall")],
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ listCatalogProviderRefreshSchedules });

    const result = await loadProviderDetail({
      request: new Request("https://admin.example/catalog/providers/tcgdex?profileVersion=2026.06.04"),
      params: { providerKey: "tcgdex" },
      context: {},
    } as unknown as Parameters<typeof loadProviderDetail>[0]);

    const delegatedRequest = mockLoadHealthSurface.mock.calls[0]?.[0].request as Request;
    expect(delegatedRequest.url).toBe("https://admin.example/catalog/providers/tcgdex?profileVersion=2026.06.04");
    expect(new URL(delegatedRequest.url).searchParams.has("providerKey")).toBe(false);
    expect(result.providerRefreshSchedules).toEqual([schedule("api-answered-provider")]);
    expect(listCatalogProviderRefreshSchedules).not.toHaveBeenCalled();
    expect(result.operatorSessionActorKey).toBeNull();
    expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
  });

  it("keys the Operator session section only for a platform-admin actor on TCGplayer", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({});
    mockLoadHealthSurface.mockResolvedValueOnce({
      operatorSession: true,
      operatorSessionActorKey: "api-user:api-membership",
      providerRefreshSchedules: null,
    });

    const result = await loadProviderDetail(loaderArgs("tcgplayer"));

    expect(result.operatorSessionActorKey).toBe("api-user:api-membership");
    expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
  });

  it.each([["a non-platform-admin actor"], ["an anonymous request"], ["a failed actor resolution"]])(
    "hides the Operator session section when the API denies %s",
    async () => {
      mockCreateCatalogRequestApiClient.mockReturnValue({});

      const result = await loadProviderDetail(loaderArgs("tcgplayer"));

      expect(result.operatorSessionActorKey).toBeNull();
      expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
    },
  );

  it("forwards health answers through the real loader and HTTP client adapter unchanged", async () => {
    const url =
      "https://admin.example/catalog/providers/tcgplayer?providerKey=tcgdex&profileVersion=selected&jobId=job-a";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: url,
      scopes: { items: [], count: 0, total: 0 },
      profileReviews: { items: [], count: 0, total: 0 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });
    const answer = {
      readModel,
      readModelFailures: [],
      catalogSyncScope: null,
      providerRefreshSchedules: [schedule("api-only")],
      operatorSession: true,
      operatorSessionActorKey: "api-user:api-membership",
    };
    const locations: string[] = [];
    const api = createCatalogApiClient({
      baseUrl: "https://catalog.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const location = new URL(request.url).searchParams.get("location");
        if (location) locations.push(location);
        return Response.json(answer);
      },
    });
    mockCreateCatalogRequestApiClient.mockReturnValue({ ...api, recordCatalogControlPlaneEvent: undefined });
    const actual = await vi.importActual<typeof import("./integrations-loader-support")>(
      "./integrations-loader-support",
    );
    mockLoadHealthSurface.mockImplementationOnce(actual.loadHealthSurface);
    const result = await loadProviderDetail({ ...loaderArgs("tcgplayer"), request: new Request(url) });
    expect(locations).toEqual([new URL(url).pathname + new URL(url).search]);
    expect(result).toMatchObject({
      readModel: JSON.parse(JSON.stringify(readModel)),
      requestUrl: url,
      providerRefreshSchedules: answer.providerRefreshSchedules,
      operatorSession: true,
      operatorSessionActorKey: answer.operatorSessionActorKey,
    });
    expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
  });

  it("runs and pauses refreshes for the path provider without leaving its selected profile", async () => {
    const runCatalogProviderRefreshNow = vi.fn().mockResolvedValue({});
    const setCatalogProviderRefreshPaused = vi.fn().mockResolvedValue({});
    mockCreateCatalogRequestApiClient.mockReturnValue({
      runCatalogProviderRefreshNow,
      setCatalogProviderRefreshPaused,
    });

    const runResponse = await providerDetailAction(
      actionArgs("run-provider-refresh", "https://admin.example/catalog/providers/tcgdex?profileVersion=2026.06.04"),
    );
    const pauseResponse = await providerDetailAction(
      actionArgs("pause-provider-refresh", "https://admin.example/catalog/providers/tcgdex?profileVersion=2026.06.04"),
    );

    expect(runCatalogProviderRefreshNow).toHaveBeenCalledWith("tcgdex");
    expect(setCatalogProviderRefreshPaused).toHaveBeenCalledWith({ providerKey: "tcgdex", paused: true });
    for (const response of [runResponse, pauseResponse]) {
      const location = new URL(response.headers.get("Location") ?? "", "https://admin.example");
      expect(location.pathname).toBe("/catalog/providers/tcgdex");
      expect(location.searchParams.get("profileVersion")).toBe("2026.06.04");
    }
  });

  it.each(["retry", "resume", "cancel"] as const)(
    "submits job.%s through the Provider action and real API permission boundary, retaining selected inspection",
    async (verb) => {
      const { services } = lifecycleApi(true);
      const response = await providerDetailAction(jobActionArgs(`job.${verb}`));
      expect(services[`${verb}IntegrationJob`]).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "selected-job" }),
      );
      for (const other of ["retry", "resume", "cancel"] as const) {
        if (other !== verb) expect(services[`${other}IntegrationJob`]).not.toHaveBeenCalled();
      }
      const location = new URL(response.headers.get("Location")!, "https://admin.example");
      expect(location.pathname).toBe("/catalog/providers/tcgdex");
      expect(location.searchParams.get("jobId")).toBe("selected-job");
      expect(location.searchParams.get("unitKey")).toBe("tcgdex:card");
      expect(location.searchParams.get("commandStatus")).toBe("success");
      expect(location.searchParams.get("commandResult")).toBe(verb === "cancel" ? "job-cancelled" : "job-queued");
    },
  );

  it.each(["retry", "resume", "cancel"] as const)(
    "rejects a forged job.%s POST from a denied actor at the real API gate",
    async (verb) => {
      const { services, statuses } = lifecycleApi(false);
      const response = await providerDetailAction(jobActionArgs(`job.${verb}`));
      expect(services[`${verb}IntegrationJob`]).not.toHaveBeenCalled();
      expect(statuses).toEqual([403]);
      const location = new URL(response.headers.get("Location")!, "https://admin.example");
      expect(location.searchParams.get("commandStatus")).toBe("error");
      expect(location.searchParams.get("commandResult")).toBe("command-failed");
    },
  );

  it.each(["job_not_found", "unsupported_state"] as const)(
    "preserves %s as a failed command instead of claiming a transition",
    async (code) => {
      const { services, statuses } = lifecycleApi(true);
      services.retryIntegrationJob.mockRejectedValue(
        new SourceObservationIntegrationJobLifecycleCommandError(code, "synthetic lifecycle refusal"),
      );
      const response = await providerDetailAction(jobActionArgs("job.retry"));
      expect(statuses).toEqual([code === "job_not_found" ? 404 : 409]);
      const location = new URL(response.headers.get("Location")!, "https://admin.example");
      expect(location.searchParams.get("commandStatus")).toBe("error");
      expect(location.searchParams.get("jobId")).toBe("selected-job");
    },
  );
});

function lifecycleApi(canManage: boolean) {
  const services = {
    retryIntegrationJob: vi.fn().mockResolvedValue({ jobId: "selected-job" }),
    resumeIntegrationJob: vi.fn().mockResolvedValue({ jobId: "selected-job" }),
    cancelIntegrationJob: vi.fn().mockResolvedValue({ jobId: "selected-job" }),
    previewCatalogSyncScope: vi.fn(),
    enqueueCatalogSyncRun: vi.fn(),
    getCatalogSyncRun: vi.fn(),
    getCatalogScopeSyncState: vi.fn(),
    previewIntegrationImport: vi.fn(),
    enqueueIntegrationJob: vi.fn(),
    getIntegrationJob: vi.fn(),
    listIntegrationJobEvents: vi.fn(),
    waitForIntegrationJobEvents: vi.fn(),
    listActiveIntegrationJobs: vi.fn(),
    listRecentIntegrationJobs: vi.fn(),
    processNextIntegrationJob: vi.fn(),
    getIntegrationWorkUnitSummary: vi.fn(),
  } satisfies IntegrationJobRouteServices;
  const app = new Hono<CatalogAuthoringEnv>();
  const context: EventStoreContext = {
    tenantId: "tnt_test" as TenantId,
    audit: { performedByUserId: "usr_test" as UserId, forAccountId: "acc_test" as AccountId },
  };
  app.use("*", async (c, next) => {
    c.set("actor", { permissions: canManage ? ["catalog.view", "catalog.manage"] : ["catalog.view"] });
    c.set("context", context);
    await next();
  });
  app.route("/source-observations", integrationJobRoutes(services));
  const statuses: number[] = [];
  const api = createCatalogApiClient({
    baseUrl: "https://catalog.test",
    fetch: async (input, init) => {
      const response = await app.fetch(new Request(input, init));
      statuses.push(response.status);
      return response;
    },
  });
  mockCreateCatalogRequestApiClient.mockReturnValue({ ...api, recordCatalogControlPlaneEvent: undefined });
  return { services, statuses };
}

function jobActionArgs(intent: string): Parameters<typeof providerDetailAction>[0] {
  return {
    request: new Request("https://admin.example/catalog/providers/tcgdex", {
      method: "POST",
      body: new URLSearchParams({
        _intent: intent,
        providerKey: "tcgdex",
        unitKey: "tcgdex:card",
        jobId: "selected-job",
      }),
    }),
    params: { providerKey: "tcgdex" },
    context: {},
  } as unknown as Parameters<typeof providerDetailAction>[0];
}

function loaderArgs(providerKey: string): Parameters<typeof loadProviderDetail>[0] {
  return {
    request: new Request(`https://admin.example/catalog/providers/${providerKey}`),
    params: { providerKey },
    context: {},
  } as unknown as Parameters<typeof loadProviderDetail>[0];
}

function actionArgs(intent: string, url: string): Parameters<typeof providerDetailAction>[0] {
  return {
    request: new Request(url, {
      method: "POST",
      body: new URLSearchParams({ _intent: intent, providerKey: "different-provider" }),
    }),
    params: { providerKey: "tcgdex" },
    context: {},
  } as unknown as Parameters<typeof providerDetailAction>[0];
}

function schedule(providerKey: string) {
  return {
    providerKey,
    scheduleEnabled: true,
    manualOnly: false,
    creditAware: false,
    intervalMs: 21_600_000,
    paused: false,
    pausedBy: null,
    nextRunAt: "2026-07-14T18:00:00.000Z",
    lastRunCompletedAt: "2026-07-14T12:00:00.000Z",
    lastRunStatus: "succeeded" as const,
    lastRunError: null,
  };
}
