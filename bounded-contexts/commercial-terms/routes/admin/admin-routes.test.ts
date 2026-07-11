import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateAfterWrite, readFreshWriteToken } from "@chase-sets/http/responses";

const {
  MockCommercialTermsApiError,
  mockApi,
  mockCreateCommercialTermsRequestApiClient,
  commercialTermsCommit,
  projectionFreshnessTimeout,
} = vi.hoisted(() => {
  class MockCommercialTermsApiError extends Error {
    public constructor(
      public readonly status: number,
      public readonly body: unknown,
      message = "Commercial Terms API request failed.",
    ) {
      super(message);
    }
  }

  function commercialTermsCommit(position = "42") {
    return {
      id: "cts_committed",
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

  function projectionFreshnessTimeout() {
    return new MockCommercialTermsApiError(
      503,
      {
        error: {
          code: "projection_freshness_timeout",
          message: "Commercial Terms projection is catching up.",
        },
      },
      "Commercial Terms projection is catching up.",
    );
  }

  return {
    MockCommercialTermsApiError,
    mockApi: {
      listSchedules: vi.fn(),
      getSchedule: vi.fn(),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      listAgreements: vi.fn(),
      getAgreement: vi.fn(),
      createAgreement: vi.fn(),
      updateAgreement: vi.fn(),
    },
    mockCreateCommercialTermsRequestApiClient: vi.fn(),
    commercialTermsCommit,
    projectionFreshnessTimeout,
  };
});

vi.mock("../../support/request-support/api-client", () => ({
  CommercialTermsApiError: MockCommercialTermsApiError,
  createCommercialTermsRequestApiClient: mockCreateCommercialTermsRequestApiClient,
}));

import { action as agreementsAction, loader as agreementsLoader } from "./agreements";
import { action as accountAgreementNewAction, loader as accountAgreementNewLoader } from "./account-agreement-new";
import { action as agreementDetailAction, loader as agreementDetailLoader } from "./agreements-detail";
import { action as schedulesAction, loader as schedulesLoader } from "./schedules";
import { action as scheduleDetailAction } from "./schedules-detail";
import contextManifest from "../../context.json";

function formRequest(path: string, values: Record<string, string>) {
  return new Request(`https://admin.chasesets.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

function freshnessRequest(path: string, position = "42") {
  return new Request(`https://admin.chasesets.com${navigateAfterWrite(commercialTermsCommit(position), path)}`);
}

function expiredFreshnessRequest(path: string, position = "42") {
  return new Request(
    `https://admin.chasesets.com${navigateAfterWrite(commercialTermsCommit(position), path, { nowMs: 0 })}`,
  );
}

function scheduleForm() {
  return {
    label: "Business",
    accountType: "business",
    marketplaceSalesFeePercentageBps: "650",
    marketplaceSalesFeeFixedAmount: "0.00",
    shippingAllowancePercentageBps: "750",
    status: "active",
    effectiveFrom: "2026-05-01T00:00:00.000Z",
    effectiveUntil: "",
  };
}

function agreementForm() {
  return {
    label: "Preferred",
    accountId: "acc_seller",
    marketplaceSalesFeePercentageBps: "550",
    marketplaceSalesFeeFixedAmount: "0.00",
    shippingAllowancePercentageBps: "700",
    status: "active",
    effectiveFrom: "2026-05-01T00:00:00.000Z",
    effectiveUntil: "",
  };
}

describe("commercial terms admin routes", () => {
  beforeEach(() => {
    mockCreateCommercialTermsRequestApiClient.mockReturnValue(mockApi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("contributes the account-scoped agreement creation admin route", () => {
    expect(contextManifest.deployableContributions[0]?.routes).toContainEqual({
      routeId: "commercial-terms-account-agreement-new",
      routePath: "terms/accounts/:accountId/agreements/new",
      fileExport: "./routes/admin/account-agreement-new",
      routeType: "route",
      sourceContext: "commercial-terms",
      section: "commerce",
    });
  });

  it("carries schedule create receipts into the list redirect", async () => {
    mockApi.createSchedule.mockResolvedValue(commercialTermsCommit("51"));

    const response = (await schedulesAction({
      request: formRequest("/commerce/terms/schedules", scheduleForm()),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/commerce/terms/schedules?afterWrite=");
    expect(readFreshWriteToken(`https://admin.chasesets.com${location}`)?.commitPosition).toBe("51");
  });

  it("carries schedule update receipts into the detail redirect", async () => {
    mockApi.updateSchedule.mockResolvedValue(commercialTermsCommit("52"));

    const response = (await scheduleDetailAction({
      request: formRequest("/commerce/terms/schedules/cts_business", scheduleForm()),
      params: { id: "cts_business" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/commerce/terms/schedules/cts_business?afterWrite=");
    expect(readFreshWriteToken(`https://admin.chasesets.com${location}`)?.commitPosition).toBe("52");
  });

  it("carries agreement create receipts into the list redirect", async () => {
    mockApi.createAgreement.mockResolvedValue(commercialTermsCommit("53"));

    const response = (await agreementsAction({
      request: formRequest("/commerce/terms/agreements", agreementForm()),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/commerce/terms/agreements?afterWrite=");
    expect(readFreshWriteToken(`https://admin.chasesets.com${location}`)?.commitPosition).toBe("53");
  });

  it("rejects malformed agreement account ids before create requests", async () => {
    const response = await agreementsAction({
      request: formRequest("/commerce/terms/agreements", {
        ...agreementForm(),
        accountId: "seller_missing",
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response).toEqual({ error: "Account ID must start with acc_." });
    expect(mockApi.createAgreement).not.toHaveBeenCalled();
  });

  it("loads account-scoped agreement creation from the route account id", async () => {
    await expect(
      accountAgreementNewLoader({
        request: new Request("https://admin.chasesets.com/commerce/terms/accounts/acc_seller/agreements/new"),
        params: { accountId: "acc_seller" },
        context: undefined,
      } as never),
    ).resolves.toEqual({ accountId: "acc_seller" });
  });

  it("creates account-scoped agreements from the route account id", async () => {
    mockApi.createAgreement.mockResolvedValue(commercialTermsCommit("58"));

    const response = (await accountAgreementNewAction({
      request: formRequest("/commerce/terms/accounts/acc_route/agreements/new", {
        ...agreementForm(),
        accountId: "acc_tampered",
      }),
      params: { accountId: "acc_route" },
      context: undefined,
    } as never)) as Response;

    expect(mockApi.createAgreement).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc_route" }));
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/commerce/terms/agreements?afterWrite=");
    expect(readFreshWriteToken(`https://admin.chasesets.com${location}`)?.commitPosition).toBe("58");
  });

  it("rejects malformed route account ids before account-scoped create requests", async () => {
    const response = await accountAgreementNewAction({
      request: formRequest("/commerce/terms/accounts/seller_missing/agreements/new", agreementForm()),
      params: { accountId: "seller_missing" },
      context: undefined,
    } as never);

    expect(response).toEqual({ error: "Account ID must start with acc_." });
    expect(mockApi.createAgreement).not.toHaveBeenCalled();
  });

  it("carries agreement update receipts into the detail redirect", async () => {
    mockApi.updateAgreement.mockResolvedValue(commercialTermsCommit("54"));

    const response = (await agreementDetailAction({
      request: formRequest("/commerce/terms/agreements/cag_preferred", agreementForm()),
      params: { id: "cag_preferred" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/commerce/terms/agreements/cag_preferred?afterWrite=");
    expect(readFreshWriteToken(`https://admin.chasesets.com${location}`)?.commitPosition).toBe("54");
  });

  it("recovers schedule list projection lag after a fresh write", async () => {
    mockApi.listSchedules.mockRejectedValue(projectionFreshnessTimeout());

    const result = await schedulesLoader({
      request: freshnessRequest("/commerce/terms/schedules", "55"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      items: [],
      pagination: { limit: 50, offset: 0, total: 0 },
      loadError: "Commercial Terms projection is catching up.",
    });
  });

  it("recovers agreement detail projection lag after a fresh write", async () => {
    mockApi.getAgreement.mockRejectedValue(projectionFreshnessTimeout());

    const result = await agreementDetailLoader({
      request: freshnessRequest("/commerce/terms/agreements/cag_preferred", "56"),
      params: { id: "cag_preferred" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      agreement: null,
      loadError: "Commercial Terms projection is catching up.",
    });
  });

  it("keeps expired agreement detail receipts inside the route-owned unavailable state", async () => {
    mockApi.getAgreement.mockRejectedValue(projectionFreshnessTimeout());

    const result = await agreementDetailLoader({
      request: expiredFreshnessRequest("/commerce/terms/agreements/cag_preferred", "57"),
      params: { id: "cag_preferred" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      agreement: null,
      loadError: "Commercial Terms projection is catching up.",
    });
  });

  it("loads schedule and agreement pages normally without a fresh-write token", async () => {
    mockApi.listSchedules.mockResolvedValue({ items: [{ schedule_id: "cts_business" }], total: 1, count: 1 });
    mockApi.listAgreements.mockResolvedValue({ items: [{ agreement_id: "cag_preferred" }], total: 1, count: 1 });

    await expect(
      schedulesLoader({
        request: new Request("https://admin.chasesets.com/commerce/terms/schedules"),
        params: {},
        context: undefined,
      } as never),
    ).resolves.toEqual({
      items: [{ schedule_id: "cts_business" }],
      pagination: { limit: 50, offset: 0, total: 1 },
      loadError: null,
    });
    await expect(
      agreementsLoader({
        request: new Request("https://admin.chasesets.com/commerce/terms/agreements"),
        params: {},
        context: undefined,
      } as never),
    ).resolves.toEqual({
      items: [{ agreement_id: "cag_preferred" }],
      pagination: { limit: 50, offset: 0, total: 1 },
      loadError: null,
    });
  });

  it("forwards URL pagination to the schedules and agreements Commercial Terms API lists", async () => {
    mockApi.listSchedules.mockResolvedValue({ items: [], total: 0, count: 0 });
    mockApi.listAgreements.mockResolvedValue({ items: [], total: 0, count: 0 });

    await schedulesLoader({
      request: new Request("https://admin.chasesets.com/commerce/terms/schedules?limit=25&offset=50"),
      params: {},
      context: undefined,
    } as never);
    await agreementsLoader({
      request: new Request("https://admin.chasesets.com/commerce/terms/agreements?limit=25&offset=50"),
      params: {},
      context: undefined,
    } as never);

    expect(mockApi.listSchedules).toHaveBeenCalledWith("limit=25&offset=50");
    expect(mockApi.listAgreements).toHaveBeenCalledWith("limit=25&offset=50");
  });
});
