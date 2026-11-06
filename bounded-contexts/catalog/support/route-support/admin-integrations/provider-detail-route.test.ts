import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerDetailAction } from "./provider-detail-action";
import { loadProviderDetail } from "./provider-detail-loader";
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

vi.mock("../../request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));

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
    });
  });

  it("loads only the selected provider schedule and seeds provider identity from the route", async () => {
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
    expect(new URL(delegatedRequest.url).searchParams.get("providerKey")).toBe("tcgdex");
    expect(result.providerRefreshSchedules).toEqual([schedule("tcgdex")]);
    expect(result.operatorSessionActorKey).toBeNull();
    expect(mockResolveActorFromAuthApi).not.toHaveBeenCalled();
  });

  it("keys the Operator session section only for a platform-admin actor on TCGplayer", async () => {
    mockCreateCatalogRequestApiClient.mockReturnValue({});
    mockResolveActorFromAuthApi.mockResolvedValueOnce(actor("platform-admin"));

    const result = await loadProviderDetail(loaderArgs("tcgplayer"));

    expect(result.operatorSessionActorKey).toBe("user-1:membership-1");
    expect(mockResolveActorFromAuthApi).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-platform-admin actor", () => mockResolveActorFromAuthApi.mockResolvedValueOnce(actor("catalog-admin"))],
    ["an anonymous request", () => mockResolveActorFromAuthApi.mockResolvedValueOnce(null)],
    ["a failed actor resolution", () => mockResolveActorFromAuthApi.mockRejectedValueOnce(new Error("auth down"))],
  ])("hides the Operator session section from %s", async (_label, arrange) => {
    mockCreateCatalogRequestApiClient.mockReturnValue({});
    arrange();

    const result = await loadProviderDetail(loaderArgs("tcgplayer"));

    expect(result.operatorSessionActorKey).toBeNull();
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

function actor(roleKey: string) {
  return {
    sessionId: "session-1",
    tenantId: "tenant-1",
    userId: "user-1",
    accountId: "account-1",
    membershipId: "membership-1",
    roleKey,
    permissions: ["catalog.view", "catalog.manage"],
  };
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
