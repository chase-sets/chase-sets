import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFreshWriteToken } from "@chase-sets/http/responses";

const { MockCommercialTermsApiError, mockApi, mockCreateCommercialTermsRequestApiClient, commercialTermsCommit } =
  vi.hoisted(() => {
    class MockCommercialTermsApiError extends Error {}
    function commercialTermsCommit(position = "42", id = "cts_committed") {
      return {
        id,
        version: 2,
        commandReceipt: {
          mode: "eventual",
          commitPosition: position,
          commitEventIds: [`evt_terms_${position}`],
          commitPositions: [
            {
              sourceContextName: "commercial-terms",
              maxGlobalPosition: position,
              eventIds: [`evt_terms_${position}`],
            },
          ],
        },
      };
    }
    return {
      MockCommercialTermsApiError,
      commercialTermsCommit,
      mockCreateCommercialTermsRequestApiClient: vi.fn(),
      mockApi: {
        listSchedules: vi.fn(),
        getSchedule: vi.fn(),
        createSchedule: vi.fn(),
        updateSchedule: vi.fn(),
        listAgreements: vi.fn(),
        getAgreement: vi.fn(),
        createAgreement: vi.fn(),
        updateAgreement: vi.fn(),
        listAccountOptions: vi.fn(),
      },
    };
  });

vi.mock("../../features/home/integrations/admin-api-client", () => ({
  CommercialTermsApiError: MockCommercialTermsApiError,
  createCommercialTermsRequestApiClient: mockCreateCommercialTermsRequestApiClient,
}));

import { action as homeAction, loader as homeLoader } from "./home";
import { loader as schedulesRedirectLoader } from "./schedules";
import { loader as scheduleRedirectLoader } from "./schedules-detail";
import { loader as agreementsRedirectLoader } from "./agreements";
import { loader as agreementRedirectLoader } from "./agreements-detail";
import { loader as accountAgreementRedirectLoader } from "./account-agreement-new";
import contextManifest from "../../context.json";

function formRequest(values: Record<string, string>) {
  return new Request("https://admin.chasesets.com/commerce/terms", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

function termsForm(intent: string) {
  return {
    intent,
    label: "Business",
    accountType: "business",
    marketplaceSalesFeePercentageBps: "650",
    marketplaceSalesFeeFixedAmount: "0.00",
    shippingAllowancePercentageBps: "750",
    status: "active",
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: "",
  };
}

describe("commercial terms admin home route", () => {
  beforeEach(() => {
    mockCreateCommercialTermsRequestApiClient.mockReturnValue(mockApi);
    mockApi.listSchedules.mockResolvedValue({ items: [], total: 0, count: 0 });
    mockApi.listAgreements.mockResolvedValue({ items: [], total: 0, count: 0 });
    mockApi.listAccountOptions.mockResolvedValue([]);
    mockApi.getSchedule.mockResolvedValue(null);
    mockApi.getAgreement.mockResolvedValue(null);
  });

  afterEach(() => vi.clearAllMocks());

  it("contributes one Commercial Terms home and keeps the five retired paths as redirects", () => {
    const routes = contextManifest.deployableContributions[0]?.routes ?? [];
    expect(routes.find((route) => route.routeId === "commercial-terms-home")).toMatchObject({
      routePath: "terms",
      fileExport: "./routes/admin/home",
    });
    expect(routes.filter((route) => route.routeId !== "commercial-terms-home")).toHaveLength(5);
  });

  it("loads schedules, agreements, account picker options, and selected drawer detail together", async () => {
    mockApi.listSchedules.mockResolvedValue({ items: [{ schedule_id: "cts_active" }], total: 1, count: 1 });
    mockApi.listAgreements.mockResolvedValue({ items: [{ agreement_id: "cag_launch" }], total: 1, count: 1 });
    mockApi.listAccountOptions.mockResolvedValue([{ accountId: "acc_seller" }]);
    mockApi.getSchedule.mockResolvedValue({ schedule_id: "cts_active", history: [] });

    await expect(
      homeLoader({
        request: new Request("https://admin.chasesets.com/commerce/terms?schedule=cts_active"),
        params: {},
        context: undefined,
      } as never),
    ).resolves.toMatchObject({
      schedules: [{ schedule_id: "cts_active" }],
      agreements: [{ agreement_id: "cag_launch" }],
      accounts: [{ accountId: "acc_seller" }],
      selectedSchedule: { schedule_id: "cts_active", history: [] },
      loadError: null,
    });
    expect(mockApi.listSchedules).toHaveBeenCalledWith("limit=250&offset=0");
    expect(mockApi.listAgreements).toHaveBeenCalledWith("limit=250&offset=0");
  });

  it.each([
    ["create-schedule", "createSchedule", "cts_created", "schedule", "51"],
    ["revise-schedule", "updateSchedule", "cts_active", "schedule", "52"],
    ["create-agreement", "createAgreement", "cag_created", "agreement", "53"],
    ["revise-agreement", "updateAgreement", "cag_active", "agreement", "54"],
  ] as const)("preserves fresh-read consistency for %s", async (intent, method, id, queryKey, position) => {
    mockApi[method].mockResolvedValue(commercialTermsCommit(position, id));
    const response = (await homeAction({
      request: formRequest({
        ...termsForm(intent),
        id,
        accountId: "acc_seller",
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain(`/commerce/terms?${queryKey}=${id}`);
    expect(readFreshWriteToken(`https://admin.chasesets.com${location}`)?.commitPosition).toBe(position);
  });

  it("keeps API lag inside the home-owned unavailable state", async () => {
    mockApi.listSchedules.mockRejectedValue(new Error("Commercial Terms projection is catching up."));
    await expect(
      homeLoader({
        request: new Request("https://admin.chasesets.com/commerce/terms"),
        params: {},
        context: undefined,
      } as never),
    ).resolves.toMatchObject({
      schedules: [],
      agreements: [],
      accounts: [],
      loadError: "Commercial Terms projection is catching up.",
    });
  });

  it("redirects all retired route shapes into the home query-state contract", async () => {
    const args = (request: string, params: Record<string, string> = {}) => ({
      request: new Request(request),
      params,
      context: undefined,
    });
    const responses = await Promise.all([
      schedulesRedirectLoader(args("https://admin.chasesets.com/commerce/terms/schedules") as never),
      scheduleRedirectLoader(
        args("https://admin.chasesets.com/commerce/terms/schedules/cts_active", { id: "cts_active" }) as never,
      ),
      agreementsRedirectLoader(args("https://admin.chasesets.com/commerce/terms/agreements") as never),
      agreementRedirectLoader(
        args("https://admin.chasesets.com/commerce/terms/agreements/cag_active", { id: "cag_active" }) as never,
      ),
      accountAgreementRedirectLoader(
        args("https://admin.chasesets.com/commerce/terms/accounts/acc_seller/agreements/new", {
          accountId: "acc_seller",
        }) as never,
      ),
    ]);

    expect(responses.map((response) => response.headers.get("Location"))).toEqual([
      "/commerce/terms",
      "/commerce/terms?schedule=cts_active",
      "/commerce/terms",
      "/commerce/terms?agreement=cag_active",
      "/commerce/terms?create=agreement&account=acc_seller",
    ]);
  });
});
