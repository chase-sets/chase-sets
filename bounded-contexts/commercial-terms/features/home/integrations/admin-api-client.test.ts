import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeCommitReceipt,
  getMutationResultCommandReceipt,
} from "@chase-sets/http/responses";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommercialTermsPublicRequestApiClient, createCommercialTermsRequestApiClient } from "./admin-api-client";

const publishedSchedule = {
  value: {
    label: "Synthetic revised seller terms",
    marketplaceSalesFeePercentageBps: 625,
    marketplaceSalesFeeFixedAmount: "0.42",
    marketplaceSalesFeeCapAmount: "19.75",
    shippingAllowancePercentageBps: 725,
  },
  source: "policy",
  documentId: "pol_synthetic",
  effectiveFrom: "2026-07-12T00:00:00.000Z",
  resolvedAt: "2026-07-15T12:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createCommercialTermsRequestApiClient", () => {
  it("maps account names without replacing display names, types or ids", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [
          {
            account_id: "acc_demo",
            account_name: "Demo Account",
            display_name: "Chase Sets",
            account_type: "business",
          },
          { account_id: "acc_empty", account_name: "", display_name: "Display only", account_type: "personal" },
        ],
      }),
    );
    await expect(
      createCommercialTermsRequestApiClient(
        new Request("https://admin.chasesets.com/commerce/terms"),
      ).listAccountOptions(),
    ).resolves.toEqual([
      { accountId: "acc_demo", name: "Demo Account", displayName: "Chase Sets", accountType: "business" },
      { accountId: "acc_empty", name: "", displayName: "Display only", accountType: "personal" },
    ]);
  });
  it("forwards admin session credentials and read target context to platform-api", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://platform-api.internal");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [],
      }),
    );
    const request = new Request("https://admin.chasesets.com/commerce/terms/schedules", {
      headers: {
        authorization: "Bearer admin-session",
        cookie: "session=admin",
      },
    });

    await createCommercialTermsRequestApiClient(request).listSchedules("limit=1&offset=0");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("https://platform-api.internal/api/commercial-terms/schedules?limit=1&offset=0");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer admin-session");
    expect(headers.get("cookie")).toBe("session=admin");
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("commercial-terms");
  });

  it("reports non-json API topology failures with sanitized diagnostics", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://platform-api.internal");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = new Request("https://admin.chasesets.com/commerce/terms/schedules", {
      headers: {
        authorization: "Bearer admin-session",
        cookie: "session=admin",
      },
    });

    await expect(
      createCommercialTermsRequestApiClient(request).listSchedules("limit=1&offset=0"),
    ).rejects.toMatchObject({
      status: 404,
      request: {
        method: "GET",
        origin: "https://platform-api.internal",
        pathname: "/api/commercial-terms/schedules",
        contentType: "text/plain",
      },
    });
    expect(warnMock).toHaveBeenCalledWith("[commercial-terms-admin-api] request failed", {
      status: 404,
      method: "GET",
      origin: "https://platform-api.internal",
      pathname: "/api/commercial-terms/schedules",
      contentType: "text/plain",
    });
  });

  it("attaches command receipts to commercial terms mutation results", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://platform-api.internal");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          id: "cts_business",
          version: 2,
          preview: null,
        },
        {
          status: 201,
          headers: {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Position": "42",
            "Chase-Sets-Commit-Event-Ids": "evt_terms",
            [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
              {
                sourceContextName: "commercial-terms",
                maxGlobalPosition: "42",
                eventIds: ["evt_terms"],
              },
            ]),
          },
        },
      ),
    );

    const result = await createCommercialTermsRequestApiClient(
      new Request("https://admin.chasesets.com/commerce/terms/schedules"),
    ).createSchedule({ label: "Business" });

    expect(result).toMatchObject({ id: "cts_business", version: 2, preview: null });
    expect(getMutationResultCommandReceipt(result)).toMatchObject({
      mode: "eventual",
      commitPosition: "42",
      commitEventIds: ["evt_terms"],
      commitPositions: [
        {
          sourceContextName: "commercial-terms",
          maxGlobalPosition: "42",
          eventIds: ["evt_terms"],
        },
      ],
    });
  });
});

describe("published marketplace sales fee client", () => {
  it.each([publishedSchedule, { ...publishedSchedule, source: "fallback", documentId: null, effectiveFrom: null }])(
    "reads the public endpoint and preserves the $source envelope",
    async (schedule) => {
      vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://platform-api.internal");
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(schedule));
      await expect(
        createCommercialTermsPublicRequestApiClient(
          new Request("https://admin.chasesets.com/commerce/terms"),
        ).getMarketplaceSalesFeeSchedule(),
      ).resolves.toEqual(schedule);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://platform-api.internal/api/public/commercial-terms/marketplace-sales-fee-schedule",
      );
    },
  );

  it.each([
    null,
    {},
    { ...publishedSchedule, value: null },
    { ...publishedSchedule, source: "active" },
    { ...publishedSchedule, documentId: null },
    { ...publishedSchedule, effectiveFrom: null },
    { ...publishedSchedule, effectiveFrom: "not-a-date" },
    { ...publishedSchedule, effectiveFrom: "2026" },
    { ...publishedSchedule, resolvedAt: "not-a-date" },
    { ...publishedSchedule, source: "fallback" },
    ...[
      { label: "" },
      { marketplaceSalesFeePercentageBps: "625" },
      { marketplaceSalesFeePercentageBps: null },
      { marketplaceSalesFeePercentageBps: 10001 },
      { marketplaceSalesFeeFixedAmount: "NaN" },
      { marketplaceSalesFeeCapAmount: undefined },
      { marketplaceSalesFeeCapAmount: "0.00" },
      { shippingAllowancePercentageBps: undefined },
      { shippingAllowancePercentageBps: -1 },
    ].map((value) => ({ ...publishedSchedule, value: { ...publishedSchedule.value, ...value } })),
  ])("rejects malformed available-looking envelope %#", async (schedule) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(schedule));
    await expect(
      createCommercialTermsPublicRequestApiClient(
        new Request("https://admin.chasesets.com/commerce/terms"),
      ).getMarketplaceSalesFeeSchedule(),
    ).rejects.toThrow();
  });
});
