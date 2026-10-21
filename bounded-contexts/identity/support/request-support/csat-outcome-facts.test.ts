import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { appendOnboardingCompleted, appendRegistrationCompleted } from "./lifecycle-events";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;
describe("identity lifecycle events", () => {
  it("emits identity.registration.completed event with exact payload and envelope identity", async () => {
    const { eventStore } = createInMemoryEventStore();
    await appendRegistrationCompleted(eventStore, context, {
      accountId: "acc_1" as AccountId,
      userId: "usr_1" as UserId,
    });
    const event = (await eventStore.readAll())[0];
    expect(event.eventType).toBe("identity.registration.completed");
    expect(event.eventId).toMatch(/^evt_lifecycle_/);
    expect(event.streamId).toMatch(/^identity.registration-/);
    expect(event.recordedAt).toBeTruthy();
    expect(event.payload).toEqual({ accountId: "acc_1", userId: "usr_1" });
  });

  it("keeps guest and both invitation onboarding sites successful when projection fails", async () => {
    const { eventStore } = createInMemoryEventStore();
    await expect(
      appendOnboardingCompleted(eventStore, context, {
        accountId: "acc_2" as AccountId,
        userId: "usr_2" as UserId,
        onboardingPath: "guest-account",
        idempotencyKey: "identity:onboarding:guest-account:acc_2:usr_2",
      }),
    ).resolves.toBeUndefined();
    await expect(
      appendOnboardingCompleted(eventStore, context, {
        accountId: "acc_3" as AccountId,
        userId: "usr_3" as UserId,
        onboardingPath: "invitation",
        invitationId: "inv_3",
        idempotencyKey: "identity:onboarding:invitation:inv_3:usr_3",
      }),
    ).resolves.toBeUndefined();
    await expect(
      appendOnboardingCompleted(eventStore, context, {
        accountId: "acc_4" as AccountId,
        userId: "usr_4" as UserId,
        onboardingPath: "invitation",
        invitationId: "inv_4_second-site",
        idempotencyKey: "identity:onboarding:invitation:inv_4_second-site:usr_4",
      }),
    ).resolves.toBeUndefined();
  });
});
