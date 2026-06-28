import type { EnqueueNotificationInput } from "@chase-sets/outbound-messaging";
import { describe, expect, it, vi } from "vitest";
import { projectWaitlistEventToTransactionalEmail } from "./transactional-email-projector";

describe("waitlist transactional email projector", () => {
  it("enqueues one confirmation email for recorded waitlist signups", async () => {
    let enqueued: EnqueueNotificationInput | null = null;
    const outbox = {
      enqueueNotification: vi.fn(async (input: EnqueueNotificationInput) => {
        enqueued = input;
      }),
    };

    await projectWaitlistEventToTransactionalEmail(outbox, {
      id: "evt_1",
      type: "public-presence.waitlist-signup.recorded",
      globalPosition: "1",
      trace: { traceId: "req_1" },
      timing: {
        occurredAt: "2026-05-15T12:00:00.000Z",
        recordedAt: "2026-05-15T12:00:01.000Z",
      },
      data: {
        signupId: "wls_test",
        email: "collector@example.com",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(enqueued).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          channels: expect.arrayContaining([
            expect.objectContaining({ channel: "email", to: [{ email: "collector@example.com" }] }),
          ]),
          idempotencyKey: "public-presence:waitlist-signup-confirmation:wls_test",
        }),
        source: expect.objectContaining({
          sourceEventId: "evt_1",
          sourceGlobalPosition: "1",
          projectionName: "public-presence-waitlist-transactional-email-projection",
        }),
      }),
    );
  });

  it("does not resend confirmation for duplicate waitlist updates", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };

    await projectWaitlistEventToTransactionalEmail(outbox, {
      id: "evt_2",
      type: "public-presence.waitlist-signup.updated",
      globalPosition: "2",
      trace: { traceId: "req_2" },
      timing: {
        occurredAt: "2026-05-15T12:05:00.000Z",
        recordedAt: "2026-05-15T12:05:01.000Z",
      },
      data: {
        signupId: "wls_test",
        email: "collector@example.com",
      },
    } as never);

    expect(outbox.enqueueNotification).not.toHaveBeenCalled();
  });
});
