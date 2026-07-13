import type { EnqueueNotificationInput } from "@chase-sets/outbound-messaging";
import { describe, expect, it, vi } from "vitest";
import { projectWaitlistEventToTransactionalEmail } from "./transactional-email-projector";

describe("waitlist transactional email projector", () => {
  it("enqueues four replay-stable scheduled deliveries for a recorded signup", async () => {
    const enqueued: EnqueueNotificationInput[] = [];
    const outbox = { enqueueNotification: vi.fn(async (input: EnqueueNotificationInput) => void enqueued.push(input)) };
    const db = { query: vi.fn() };
    const event = transportEvent({
      id: "evt_1",
      type: "public-presence.waitlist-signup.recorded",
      globalPosition: "1",
      streamId: "public-presence.waitlist-signup-wls_test",
      data: { signupId: "wls_test", email: "collector@example.com", recordedAt: "2026-07-12T12:00:00.000Z" },
    });

    await projectWaitlistEventToTransactionalEmail(db as never, outbox, event as never);
    await projectWaitlistEventToTransactionalEmail(db as never, outbox, event as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledTimes(8);
    expect(enqueued.slice(0, 4).map((entry) => entry.message.idempotencyKey)).toEqual(
      enqueued.slice(4).map((entry) => entry.message.idempotencyKey),
    );
    expect(enqueued.slice(0, 4).map((entry) => entry.availableAt)).toEqual([
      "2026-07-12T12:00:00.000Z",
      "2026-07-15T12:00:00.000Z",
      "2026-07-19T12:00:00.000Z",
      "2026-07-26T12:00:00.000Z",
    ]);
    expect(enqueued[0]?.source).toMatchObject({
      sourceEventId: "evt_1",
      sourceGlobalPosition: "1",
      projectionName: "public-presence-waitlist-transactional-email-projection",
    });
  });

  it("enqueues admission from the founders-window grant with the recipient account and missing-fields ask", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };
    const db = {
      query: vi.fn(async () => ({
        rows: [{ role: "sell", games: [], has_store_link: false, inventory_size: null }],
      })),
    };

    await projectWaitlistEventToTransactionalEmail(
      db as never,
      outbox,
      transportEvent({
        id: "evt_grant",
        type: "identity.account.founders-window-opened",
        globalPosition: "22",
        streamId: "identity.account-acc_seller",
        data: {
          betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
          foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
          recipientEmail: "seller@example.com",
        },
      }) as never,
    );

    expect(db.query).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        availableAt: "2026-07-31T12:00:00.000Z",
        message: expect.objectContaining({
          recipientAccountId: "acc_seller",
          messageType: "public-presence.waitlist-nurture.wave-admitted",
          templateData: expect.objectContaining({
            missingAsk: expect.stringContaining("the games you sell, your inventory-size range, and an optional"),
          }),
        }),
      }),
    );
  });

  it("ignores historical grants without a recipient and grants unrelated to a waitlist signup", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const withoutRecipient = transportEvent({
      type: "identity.account.founders-window-opened",
      streamId: "identity.account-acc_old",
      data: { betaAccessStartedAt: "2026-07-01T00:00:00.000Z", foundersWindowEndsAt: "2026-08-30T00:00:00.000Z" },
    });
    const unrelated = transportEvent({
      type: "identity.account.founders-window-opened",
      streamId: "identity.account-acc_other",
      data: {
        betaAccessStartedAt: "2026-07-31T00:00:00.000Z",
        foundersWindowEndsAt: "2026-09-29T00:00:00.000Z",
        recipientEmail: "other@example.com",
      },
    });

    await projectWaitlistEventToTransactionalEmail(db as never, outbox, withoutRecipient as never);
    await projectWaitlistEventToTransactionalEmail(db as never, outbox, unrelated as never);

    expect(db.query).toHaveBeenCalledOnce();
    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });

  it("does not schedule again for duplicate signup updates", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };
    await projectWaitlistEventToTransactionalEmail(
      { query: vi.fn() } as never,
      outbox,
      transportEvent({ type: "public-presence.waitlist-signup.updated" }) as never,
    );
    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});

function transportEvent(overrides: Record<string, unknown>) {
  return {
    id: "evt_default",
    type: "ignored",
    streamId: "public-presence.waitlist-signup-wls_test",
    streamVersion: 1,
    globalPosition: "1",
    tenantId: "tenant_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
    trace: { traceId: "req_1" },
    timing: { occurredAt: "2026-07-12T12:00:00.000Z", recordedAt: "2026-07-12T12:00:01.000Z" },
    metadata: {},
    data: {},
    ...overrides,
  };
}
