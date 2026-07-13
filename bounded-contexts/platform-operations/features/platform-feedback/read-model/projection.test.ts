import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildPlatformFeedbackProjectionHandlers } from "./projection";

function transportEvent(type: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_test",
    streamId: "platform-operations.platform-feedback-pfb_test",
    globalPosition: "1",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
    timing: { occurredAt: "2026-05-07T12:00:00.000Z", recordedAt: "2026-05-07T12:00:00.000Z" },
  });
}

describe("platform feedback projections", () => {
  it("projects submitted feedback into the review queue read model", async () => {
    const queries: (readonly unknown[])[] = [];
    const db = {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
        queries.push(params ?? []);
        return { rows: [] };
      }),
    };
    const handlers = buildPlatformFeedbackProjectionHandlers(db as never);
    const handler = handlers["experience.platform-feedback.submitted"];
    if (!handler) {
      throw new Error("Expected submitted projection handler.");
    }

    await handler(
      transportEvent("experience.platform-feedback.submitted", {
        feedbackId: "pfb_test",
        userId: "usr_test",
        accountId: "acc_test",
        rating: 5,
        topic: "checkout-payment",
        comment: "Fast checkout.",
        followUpConsent: true,
        workflow: "checkout-payment",
        sourceRoutePath: "/account/payments/pay_test",
        relatedEntities: [{ type: "payment", id: "pay_test" }],
        relatedEntityKey: "payment:pay_test",
        submittedAt: "2026-05-07T12:00:00.000Z",
      }),
    );

    expect(queries[0]).toEqual([
      "pfb_test",
      "usr_test",
      "acc_test",
      5,
      "checkout-payment",
      "Fast checkout.",
      true,
      "checkout-payment",
      "/account/payments/pay_test",
      JSON.stringify([{ type: "payment", id: "pay_test" }]),
      "payment:pay_test",
      "2026-05-07T12:00:00.000Z",
    ]);
  });

  it("projects dismissal snoozes and admin status changes", async () => {
    const queries: (readonly unknown[])[] = [];
    const db = {
      query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
        queries.push(params ?? []);
        return { rows: [] };
      }),
    };
    const handlers = buildPlatformFeedbackProjectionHandlers(db as never);
    const dismissed = handlers["experience.platform-feedback.prompt-dismissed"];
    const reviewed = handlers["experience.platform-feedback.reviewed"];
    const archived = handlers["experience.platform-feedback.archived"];
    const noted = handlers["experience.platform-feedback.operator-note-recorded"];
    if (!dismissed || !reviewed || !archived || !noted) {
      throw new Error("Expected projection handlers.");
    }

    await dismissed(
      transportEvent("experience.platform-feedback.prompt-dismissed", {
        promptId: "pfp_test",
        userId: "usr_test",
        accountId: "acc_test",
        workflow: "inventory-adjust",
        sourceRoutePath: "/account/inventory/inv_test",
        relatedEntities: [{ type: "inventoryItem", id: "inv_test" }],
        relatedEntityKey: "inventoryItem:inv_test",
        dismissedAt: "2026-05-07T12:00:00.000Z",
        snoozedUntil: "2026-05-14T12:00:00.000Z",
      }),
    );
    await reviewed(
      transportEvent("experience.platform-feedback.reviewed", {
        feedbackId: "pfb_test",
        reviewedByUserId: "usr_admin",
        reviewedAt: "2026-05-07T13:00:00.000Z",
      }),
    );
    await archived(
      transportEvent("experience.platform-feedback.archived", {
        feedbackId: "pfb_test",
        archivedByUserId: "usr_admin",
        archivedAt: "2026-05-07T14:00:00.000Z",
      }),
    );
    await noted(
      transportEvent("experience.platform-feedback.operator-note-recorded", {
        feedbackId: "pfb_test",
        noteId: "pfn_test",
        body: "Follow up with checkout team.",
        recordedByUserId: "usr_admin",
        recordedAt: "2026-05-07T15:00:00.000Z",
      }),
    );

    expect(queries[0]).toEqual([
      "pfp_test",
      "usr_test",
      "acc_test",
      "inventory-adjust",
      "/account/inventory/inv_test",
      JSON.stringify([{ type: "inventoryItem", id: "inv_test" }]),
      "inventoryItem:inv_test",
      "2026-05-07T12:00:00.000Z",
      "2026-05-14T12:00:00.000Z",
    ]);
    expect(queries[1]).toEqual(["pfb_test", "usr_admin", "2026-05-07T13:00:00.000Z"]);
    expect(queries[2]).toEqual(["pfb_test", "usr_admin", "2026-05-07T14:00:00.000Z"]);
    expect(queries[3]).toEqual([
      "pfb_test",
      JSON.stringify([
        {
          noteId: "pfn_test",
          body: "Follow up with checkout team.",
          recordedByUserId: "usr_admin",
          recordedAt: "2026-05-07T15:00:00.000Z",
        },
      ]),
      "2026-05-07T15:00:00.000Z",
      JSON.stringify([{ noteId: "pfn_test" }]),
    ]);
  });
});
