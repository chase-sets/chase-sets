import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { appendRegistrationCompleted } from "./lifecycle-events";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;
describe("identity lifecycle events", () => {
  it("emits registration completed", async () => {
    const { eventStore } = createInMemoryEventStore();
    await appendRegistrationCompleted(eventStore, context, {
      accountId: "acc_1" as AccountId,
      userId: "usr_1" as UserId,
    });
    expect((await eventStore.readAll())[0].eventType).toBe("identity.registration.completed");
  });
});
