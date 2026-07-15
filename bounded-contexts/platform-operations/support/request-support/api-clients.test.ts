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
      if (url.endsWith("/orders/ord_1")) {
        return jsonResponse({
          orderId: "ord_1",
          openedByRole: "buyer",
          status: "ready-for-fulfillment",
          totalAmount: "24.00",
          lines: [],
        });
      }
      if (url.endsWith("/ops/escalate-overdue")) {
        return jsonResponse({ escalated: 2, skipped: 1, capped: false, total: 2 });
      }
      if (url.endsWith("/sup_1/attachments")) {
        return jsonResponse(
          {
            attachments: [
              {
                attachmentId: "sea_photo",
                reference:
                  "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg",
                contentType: "image/jpeg",
                byteSize: 3,
              },
            ],
          },
          201,
        );
      }
      if (url.endsWith("/sup_1/evidence")) {
        return jsonResponse({ id: "sup_1", version: 2, status: "evidence-submitted" });
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
      if (url.includes("/support-requests/sup_1/")) {
        const status = url.endsWith("/evidence")
          ? "evidence-submitted"
          : url.endsWith("/responses")
            ? "response-recorded"
            : url.endsWith("/accept")
              ? "offer-accepted"
              : url.endsWith("/decline")
                ? "offer-declined"
                : url.endsWith("/escalate")
                  ? "escalated"
                  : "cancelled";
        return jsonResponse({ id: "sup_1", version: 3, status });
      }
      return jsonResponse({ id: "sup_1", version: 1, status: "opened" }, 201);
    });
    const client = createSupportRequestApiClient({ baseUrl: "https://api.example.test", fetch: fetchMock as never });

    await expect(client.getSupportOrderContext("ord_1")).resolves.toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
      lines: [],
    });
    await expect(
      client.openSupportRequest({
        orderId: "ord_1",
        flowType: "product-not-received",
        affectedLineIds: ["line_1"],
      }),
    ).resolves.toEqual({ id: "sup_1", version: 1, status: "opened" });
    await expect(
      client.uploadSupportEvidenceAttachments("sup_1", [new File(["photo"], "card.jpg", { type: "image/jpeg" })]),
    ).resolves.toMatchObject({ attachments: [{ attachmentId: "sea_photo" }] });
    await expect(
      client.submitSupportEvidence("sup_1", {
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Damage photos",
        attachments: [
          "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg",
        ],
      }),
    ).resolves.toEqual({ id: "sup_1", version: 2, status: "evidence-submitted" });
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
        responsibility: "undetermined",
        evidenceBasis: { type: "insufficient-evidence", reference: "support-test.conflicting-evidence.v1" },
        responsibilityReasonCode: "product-not-received.conflicting-evidence",
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
    await expect(
      client.submitSupportEvidence("sup_1", {
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Damaged corner",
      }),
    ).resolves.toEqual({ id: "sup_1", version: 3, status: "evidence-submitted" });
    await expect(
      client.recordSupportResponse("sup_1", {
        submittedByRole: "seller",
        responseType: "offer-partial-refund",
        summary: "Offer five dollars",
        offerResolutionType: "partial-refund",
        refundAmount: "5.00",
      }),
    ).resolves.toEqual({ id: "sup_1", version: 3, status: "response-recorded" });
    await expect(client.acceptSupportOffer("sup_1", "sof_1")).resolves.toEqual({
      id: "sup_1",
      version: 3,
      status: "offer-accepted",
    });
    await expect(client.declineSupportOffer("sup_1", "sof_1", { summary: "Needs review" })).resolves.toEqual({
      id: "sup_1",
      version: 3,
      status: "offer-declined",
    });
    await expect(client.requestSupportReview("sup_1", { reason: "Needs review" })).resolves.toEqual({
      id: "sup_1",
      version: 3,
      status: "escalated",
    });
    await expect(client.cancelSupportRequest("sup_1", { reason: "Opened by mistake" })).resolves.toEqual({
      id: "sup_1",
      version: 3,
      status: "cancelled",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/orders/ord_1",
      expect.objectContaining({ headers: undefined }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          orderId: "ord_1",
          flowType: "product-not-received",
          affectedLineIds: ["line_1"],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/ops/sup_1/evidence",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ evidenceType: "support-note", summary: "Operator note" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/sup_1/attachments",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support-requests/sup_1/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          submittedByRole: "seller",
          responseType: "offer-partial-refund",
          summary: "Offer five dollars",
          offerResolutionType: "partial-refund",
          refundAmount: "5.00",
        }),
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
