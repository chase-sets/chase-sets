import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createMarketplaceReviewMcpHandlers } from "./mcp";
import type { ReviewServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["reputation.view"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    review_id: "rev_1",
    order_id: "ord_1",
    author_account_id: "acc_buyer",
    author_display_name: "Buyer",
    subject_account_id: "acc_1",
    subject_display_name: "Seller",
    author_role: "buyer",
    rating: 5,
    feedback: "Clear grading and fast shipping.",
    status: "active",
    submitted_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    withdrawn_at: null,
    ...overrides,
  };
}

function services(): ReviewServices {
  return {
    getPublicAccountSummary: vi.fn(async (accountId) => ({
      account_id: accountId,
      account_display_name: "Seller",
      average_rating: "5.00",
      review_count: 1,
      rating_1_count: 0,
      rating_2_count: 0,
      rating_3_count: 0,
      rating_4_count: 0,
      rating_5_count: 1,
      updated_at: "2026-07-08T00:00:00.000Z",
    })),
    listWrittenReviews: vi.fn(async () => ({ items: [reviewRow({ author_account_id: "acc_1" })], total: 1 })),
    listReceivedReviews: vi.fn(async () => ({ items: [reviewRow()], total: 1 })),
    listPublicAccountReviews: vi.fn(async () => ({ items: [reviewRow()], total: 1 })),
    getAccountReview: vi.fn(async (reviewId, accountId) =>
      reviewRow({ review_id: reviewId, subject_account_id: accountId }),
    ),
  } as unknown as ReviewServices;
}

describe("marketplace review MCP handlers", () => {
  it("gets the public reputation summary for an account visible to the actor", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceReviewMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.get-reputation-summary"]?.(
      mcpRequest({ accountId: "acc_1", subjectAccountId: "acc_seller" }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      subjectAccountId: "acc_seller",
      summary: { account_id: "acc_seller", average_rating: "5.00", review_count: 1 },
      gaps: { roleSplitReputation: "not-available" },
    });
    expect(fakeServices.getPublicAccountSummary).toHaveBeenCalledWith("acc_seller");
  });

  it("lists written, received, and public reviews from current read models", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceReviewMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["marketplace.list-reviews"]?.(mcpRequest({ accountId: "acc_1", side: "written" })),
    ).resolves.toMatchObject({ accountId: "acc_1", side: "written", total: 1, count: 1 });
    await expect(
      handlers.toolHandlers["marketplace.list-reviews"]?.(mcpRequest({ accountId: "acc_1", side: "received" })),
    ).resolves.toMatchObject({ accountId: "acc_1", side: "received", total: 1, count: 1 });
    await expect(
      handlers.toolHandlers["marketplace.list-reviews"]?.(
        mcpRequest({ accountId: "acc_1", side: "public", subjectAccountId: "acc_seller" }),
      ),
    ).resolves.toMatchObject({ accountId: "acc_1", subjectAccountId: "acc_seller", side: "public" });

    expect(fakeServices.listWrittenReviews).toHaveBeenCalledWith({ authorAccountId: "acc_1", limit: 50, offset: 0 });
    expect(fakeServices.listReceivedReviews).toHaveBeenCalledWith({ subjectAccountId: "acc_1", limit: 50, offset: 0 });
    expect(fakeServices.listPublicAccountReviews).toHaveBeenCalledWith({
      accountId: "acc_seller",
      limit: 50,
      offset: 0,
    });
  });

  it("rejects account mismatches before reading reputation data", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceReviewMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["marketplace.get-reputation-summary"]?.(mcpRequest({ accountId: "acc_other" })),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.getPublicAccountSummary).not.toHaveBeenCalled();
  });

  it("reads reputation summary and review resources by URI", async () => {
    const handlers = createMarketplaceReviewMcpHandlers(services());

    await expect(
      handlers.resourceHandlers["chase-sets://marketplace/{accountId}/reputation/summaries/{subjectAccountId}"]?.({
        actor,
        resource: null as never,
        uri: "chase-sets://marketplace/acc_1/reputation/summaries/acc_seller",
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ account_id: "acc_seller", review_count: 1 });
    await expect(
      handlers.resourceHandlers["chase-sets://marketplace/{accountId}/reviews/{reviewId}"]?.({
        actor,
        resource: null as never,
        uri: "chase-sets://marketplace/acc_1/reviews/rev_1",
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ review_id: "rev_1", subject_account_id: "acc_1" });
  });
});
