import { describe, expect, it, vi } from "vitest";
import { createExperienceApiClient } from "./platform-feedback-client";
import { createSupportRequestApiClient } from "./support-request-api-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("platform operations request API clients", () => {
  it("returns platform feedback command snapshots from mutating calls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/dismiss")) {
        return jsonResponse({ id: "pfp_1", version: 2, snoozedUntil: "2026-06-22T00:00:00.000Z" });
      }
      if (url.endsWith("/bulk/review")) {
        return jsonResponse({
          action: "reviewed",
          updated: 1,
          skipped: 0,
          items: [{ id: "pfb_1", version: 3, status: "reviewed" }],
        });
      }
      if (url.endsWith("/bulk/archive")) {
        return jsonResponse({
          action: "archived",
          updated: 1,
          skipped: 0,
          items: [{ id: "pfb_1", version: 4, status: "archived" }],
        });
      }
      if (url.endsWith("/review")) {
        return jsonResponse({ id: "pfb_1", version: 3, status: "reviewed" });
      }
      if (url.endsWith("/archive")) {
        return jsonResponse({ id: "pfb_1", version: 4, status: "archived" });
      }
      if (url.endsWith("/notes")) {
        return jsonResponse({ id: "pfb_1", version: 5, noteId: "pfn_1" });
      }
      return jsonResponse({ id: "pfb_1", version: 1, status: "submitted" }, 201);
    });
    const client = createExperienceApiClient({ baseUrl: "https://api.example.test", fetch: fetchMock as never });

    await expect(
      client.submitPlatformFeedback({
        rating: 5,
        topic: "checkout-payment",
        workflow: "checkout-payment",
        sourceRoutePath: "/checkout",
      }),
    ).resolves.toEqual({ id: "pfb_1", version: 1, status: "submitted" });
    await expect(
      client.dismissPlatformFeedbackPrompt({ workflow: "checkout-payment", sourceRoutePath: "/checkout" }),
    ).resolves.toEqual({ id: "pfp_1", version: 2, snoozedUntil: "2026-06-22T00:00:00.000Z" });
    await expect(client.markReviewed("pfb_1")).resolves.toEqual({ id: "pfb_1", version: 3, status: "reviewed" });
    await expect(client.archive("pfb_1")).resolves.toEqual({ id: "pfb_1", version: 4, status: "archived" });
    await expect(client.recordOperatorNote("pfb_1", { body: "Follow up." })).resolves.toEqual({
      id: "pfb_1",
      version: 5,
      noteId: "pfn_1",
    });
    await expect(client.bulkMarkReviewed({ feedbackIds: ["pfb_1"] })).resolves.toEqual({
      action: "reviewed",
      updated: 1,
      skipped: 0,
      items: [{ id: "pfb_1", version: 3, status: "reviewed" }],
    });
    await expect(client.bulkArchive({ feedbackIds: ["pfb_1"] })).resolves.toEqual({
      action: "archived",
      updated: 1,
      skipped: 0,
      items: [{ id: "pfb_1", version: 4, status: "archived" }],
    });
  });

  it("returns support request snapshots from mutating calls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/orders/ord_1?role=buyer")) {
        return jsonResponse({
          orderId: "ord_1",
          openedByRole: "buyer",
          status: "ready-for-fulfillment",
          totalAmount: "24.00",
        });
      }
      if (url.endsWith("/ops/escalate-overdue")) {
        return jsonResponse({ escalated: 2, skipped: 1, capped: false, total: 2 });
      }
      if (url.includes("/ops/sup_1/")) {
        const status = url.endsWith("/evidence")
          ? "evidence-submitted"
          : url.endsWith("/responses")
            ? "response-recorded"
            : url.endsWith("/escalate")
              ? "escalated"
              : url.endsWith("/resolve")
                ? "resolved"
                : url.endsWith("/close")
                  ? "closed"
                  : "cancelled";
        return jsonResponse({ id: "sup_1", version: 2, status });
      }
      return jsonResponse({ id: "sup_1", version: 1, status: "opened" }, 201);
    });
    const client = createSupportRequestApiClient({ baseUrl: "https://api.example.test", fetch: fetchMock as never });

    await expect(client.getSupportOrderContext("ord_1", "buyer")).resolves.toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
    });
    await expect(
      client.openSupportRequest({
        orderId: "ord_1",
        flowType: "product-not-received",
        openedByRole: "buyer",
      }),
    ).resolves.toEqual({ id: "sup_1", version: 1, status: "opened" });
    await expect(client.escalateOverdueSupportRequests({ limit: 25 })).resolves.toEqual({
      escalated: 2,
      skipped: 1,
      capped: false,
      total: 2,
    });
    await expect(client.recordSupportOperationsNote("sup_1", { summary: "Operator note" })).resolves.toEqual({
      id: "sup_1",
      version: 2,
      status: "evidence-submitted",
    });
    await expect(
      client.recordSupportOperationsResponse("sup_1", {
        responseType: "request-support-review",
        summary: "Reviewed",
      }),
    ).resolves.toEqual({ id: "sup_1", version: 2, status: "response-recorded" });
    await expect(client.escalateSupportOperationsRequest("sup_1", { reason: "Needs support owner" })).resolves.toEqual({
      id: "sup_1",
      version: 2,
      status: "escalated",
    });
    await expect(
      client.resolveSupportOperationsRequest("sup_1", {
        resolutionType: "support-reviewed",
        summary: "Reviewed",
      }),
    ).resolves.toEqual({ id: "sup_1", version: 2, status: "resolved" });
    await expect(client.closeSupportOperationsRequest("sup_1")).resolves.toEqual({
      id: "sup_1",
      version: 2,
      status: "closed",
    });
    await expect(client.cancelSupportOperationsRequest("sup_1", { reason: "Duplicate" })).resolves.toEqual({
      id: "sup_1",
      version: 2,
      status: "cancelled",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/orders/ord_1?role=buyer",
      expect.objectContaining({ headers: undefined }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/ops/sup_1/evidence",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ evidenceType: "support-note", summary: "Operator note" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/ops/sup_1/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ responseType: "request-support-review", summary: "Reviewed" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/ops/sup_1/close",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });
});
