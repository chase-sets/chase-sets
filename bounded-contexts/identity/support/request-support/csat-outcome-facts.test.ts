import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it } from "vitest";
import { publishIdentityCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

describe("identity CSAT outcome facts", () => {
  it("publishes registration and onboarding facts with identity provenance", async () => {
    const { eventStore } = createInMemoryEventStore();

    const registration = await publishIdentityCsatOutcomeFact(eventStore, context, {
      outcomeCode: "registration.completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account",
      subject: { entityType: "account", entityId: "acc_buyer" },
      idempotencyKey: "identity:registration:acc_buyer",
    });
    const onboarding = await publishIdentityCsatOutcomeFact(eventStore, context, {
      outcomeCode: "onboarding.completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account",
      subject: { entityType: "invitation", entityId: "inv_1" },
      idempotencyKey: "identity:onboarding:invitation:inv_1:usr_buyer",
    });

    expect(registration.sourceContext).toBe("identity");
    expect(onboarding.outcomeCode).toBe("onboarding.completed");
    await expect(eventStore.readAll()).resolves.toHaveLength(2);
  });
});
