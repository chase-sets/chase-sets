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
  it.each(["whole-order", "explicit-line"] as const)(
    "stages a %s attempt-bound photo batch with complete multipart binding",
    async (scope) => {
      const affectedLineIds = scope === "whole-order" ? undefined : ["line_a", "line_b"];
      const reference = `support-attachment:v1:sea_photo:${"a".repeat(64)}:jpg`;
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ attachments: [{ reference }] }, 201));
      const client = createSupportRequestApiClient({ baseUrl: "https://api.example.test", fetch: fetchMock });
      const attemptId = "10724_intake_attempt_0123456789";
      const operationId = "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      await expect(
        client.stageParticipantIntakeAttachments(
          { attemptId, orderId: "ord_1", flowType: "product-damaged", ...(affectedLineIds ? { affectedLineIds } : {}) },
          [new File(["photo"], "card.jpg", { type: "image/jpeg" })],
          operationId,
        ),
      ).resolves.toEqual({ attachments: [{ reference }] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`https://api.example.test/support-requests/participant-attempts/${attemptId}/attachments`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-support-attachment-operation-id")).toBe(operationId);
      const form = init?.body as FormData;
      expect(form.get("attemptId")).toBe(attemptId);
      expect(form.get("orderId")).toBe("ord_1");
      expect(form.get("flowType")).toBe("product-damaged");
      expect(form.getAll("affectedLineIds")).toEqual(affectedLineIds ?? []);
      expect(form.getAll("attachments")).toHaveLength(1);
    },
  );
  it("optional explicit response contract remains", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: "sup_1", version: 3, status: "response-recorded" }),
    );
    const client = createSupportRequestApiClient({
      fetch: fetchMock,
      participantAttemptId: "10797_explicit_0123456789abcdef",
    });
    const body = {
      responseType: "offer-partial-refund",
      summary: "Offer",
      offerResolutionType: "partial-refund",
      refundAmount: "6.00",
      submittedByRole: "seller",
    };
    await client.recordSupportResponse("sup_1", body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(body));
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("10797_explicit_0123456789abcdef");
    expect(headers.get("X-Support-Request-Hash")).toBe(
      "16f8da6317b6a53ce496c9756890ef921c4ba6f7c3506cdf73f0eb6b81810335",
    );
  });
  it.each(["server", "local"] as const)(
    "presents the re-upload Banner message for %s unknown references without lookup or retry (mutant: discard participant reference error)",
    async (source) => {
      const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "attachment_reference_unknown" } }, 400));
      const client = createSupportRequestApiClient({ fetch: fetchMock });
      await expect(
        client.submitSupportEvidence("sup_case", {
          submittedByRole: "buyer",
          evidenceType: "photo",
          summary: "Photos",
          attachments: [source === "local" ? "arbitrary" : `support-attachment:v1:sea_photo:${"a".repeat(64)}:jpg`],
        }),
      ).rejects.toMatchObject({
        phase: "failed-safe",
        descriptor: null,
        message: "These photos cannot be submitted. Start a new photo batch and re-upload them.",
      });
      expect(fetchMock).toHaveBeenCalledTimes(source === "local" ? 0 : 1);
    },
  );
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
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
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
      client.uploadSupportEvidenceAttachments(
        "sup_1",
        [new File(["photo"], "card.jpg", { type: "image/jpeg" })],
        "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ),
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
    ).resolves.toEqual({ id: "sup_1", version: 2, status: "evidence-submitted" });
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
    const uploadCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/sup_1/attachments"))!;
    expect(new Headers(uploadCall[1]?.headers).get("x-support-attachment-operation-id")).toBe(
      "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
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
