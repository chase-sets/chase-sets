// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { readFreshWriteToken } from "@chase-sets/http/responses";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockUseLoaderData, mockUseActionData, mockUseNavigation, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useActionData: mockUseActionData,
    useNavigation: mockUseNavigation,
    useSearchParams: () => [new URLSearchParams(), () => undefined],
  };
});

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import MarketplaceAccountPurchaseReviewRoute, { action, loader } from "../routes/marketplace/account-purchase-review";

const opportunity = {
  order_id: "ord_1",
  subject_account_id: "acc_seller",
  subject_display_name: "Seller",
  author_role: "buyer",
  eligible_at: "2026-04-02T00:00:00.000Z",
  active_review_id: null,
};

describe("marketplace account purchase review route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads the verified-purchase opportunity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/reviews/opportunities/orders/ord_1")) {
          return Promise.resolve(jsonResponse(opportunity));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/purchases/ord_1/review"),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.opportunity.subject_account_id).toBe("acc_seller");
  });

  it("refuses to open the review form for a non-verified purchase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/reviews/opportunities/orders/ord_2")) {
          return Promise.resolve(jsonResponse({ error: "Review opportunity not found." }, 404));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    await expect(
      loader({
        request: new Request("http://localhost/account/purchases/ord_2/review"),
        params: { purchaseId: "ord_2" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("submits a purchase-side account review and redirects to the new review page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/reviews/opportunities/orders/ord_1")) {
          return Promise.resolve(jsonResponse(opportunity));
        }

        if (url.includes("/api/marketplace/reviews") && (init?.method ?? "GET").toUpperCase() === "POST") {
          return Promise.resolve(
            jsonResponse({ id: "rev_1", version: 1 }, 201, {
              "Chase-Sets-Consistency": "eventual",
              "Chase-Sets-Commit-Receipt": encodeURIComponent(
                JSON.stringify([
                  {
                    sourceContextName: "marketplace",
                    maxGlobalPosition: "44",
                    eventIds: ["evt_review_submitted"],
                  },
                ]),
              ),
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const form = new FormData();
    form.set("rating", "5");
    form.set("feedback", "Great seller.");

    const response = await action({
      request: new Request("http://localhost/account/purchases/ord_1/review", {
        method: "POST",
        body: form,
      }),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      throw new Error("Expected redirect response.");
    }
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/reviews\/rev_1\?afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "44",
        eventIds: ["evt_review_submitted"],
      },
    ]);
  });

  it("renders the purchase-side account review submission page", () => {
    mockUseLoaderData.mockReturnValue({ opportunity });

    render(
      <ChaseRoot>
        <MarketplaceAccountPurchaseReviewRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Submit account review")).toBeTruthy();
  });
});
