import { describe, expect, it } from "vitest";
import {
  mapSupportRequestOpenedToTransactionalEmail,
  mapSupportRequestResolvedToTransactionalEmail,
} from "./transactional-email-intents";

describe("support request transactional email intents", () => {
  it("maps opened and resolved support requests to buyer transactional emails", () => {
    const opened = mapSupportRequestOpenedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      orderId: "ord_123",
      flowType: "item-not-as-described",
      correlationId: "trace_1",
    });
    const resolved = mapSupportRequestResolvedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      orderId: "ord_123",
      flowType: "item-not-as-described",
      resolutionType: "partial-refund",
      correlationId: "trace_1",
    });

    expect(opened).toMatchObject({
      messageType: "support.support-request.opened",
      criticality: "operational",
      templateId: "support_request_opened",
      title: "Support request SUP-E6K7M8N9 opened for order ord_123",
      templateData: { supportReference: "SUP-E6K7M8N9" },
    });
    expect(resolved).toMatchObject({
      messageType: "support.support-request.resolved",
      templateId: "support_request_resolved",
      title: "Support request SUP-E6K7M8N9 resolved for order ord_123",
      templateData: { supportReference: "SUP-E6K7M8N9" },
    });
  });
});
