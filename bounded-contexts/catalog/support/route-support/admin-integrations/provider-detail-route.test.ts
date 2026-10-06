import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerDetailAction } from "./provider-detail-action";
import { loadProviderDetail } from "./provider-detail-loader";

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
});

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
