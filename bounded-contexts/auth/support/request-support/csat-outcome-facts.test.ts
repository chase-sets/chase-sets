import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it } from "vitest";
import { publishAuthenticationCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

describe("auth CSAT outcome facts", () => {
  it("publishes one material authentication outcome per session", async () => {
    const { eventStore } = createInMemoryEventStore();
    const input = { subjectAccountId: "acc_buyer", sessionId: "ses_1" };

    await expect(publishAuthenticationCsatOutcomeFact(eventStore, context, input)).resolves.toMatchObject({
      factSchemaVersion: 1,
      outcomeCode: "authentication.completed",
      sourceContext: "auth",
      subject: { entityType: "session", entityId: "ses_1" },
    });
    await publishAuthenticationCsatOutcomeFact(eventStore, context, input);

    await expect(eventStore.readAll()).resolves.toHaveLength(1);
  });
});
