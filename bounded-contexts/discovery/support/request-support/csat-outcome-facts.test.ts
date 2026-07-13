import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it } from "vitest";
import { publishDiscoveryCsatOutcomeFact } from "./csat-outcome-facts";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
  trace: {},
} as EventStoreContext;

describe("discovery CSAT outcome facts", () => {
  it("publishes a server-owned search completion once per session", async () => {
    const { eventStore } = createInMemoryEventStore();
    const input = {
      outcomeCode: "discovery.search-completed",
      subjectAccountId: "acc_buyer",
      subjectKind: "account" as const,
      subject: { entityType: "session", entityId: "ses_1" },
      idempotencyKey: "discovery:search-session:ses_1",
    };

    await expect(publishDiscoveryCsatOutcomeFact(eventStore, context, input)).resolves.toMatchObject({
      factSchemaVersion: 1,
      outcomeCode: "discovery.search-completed",
      sourceContext: "discovery",
      subjectAccountId: "acc_buyer",
    });
    await publishDiscoveryCsatOutcomeFact(eventStore, context, input);

    await expect(eventStore.readAll()).resolves.toHaveLength(1);
  });

  it("rejects codes owned by another source context", async () => {
    const { eventStore } = createInMemoryEventStore();

    await expect(
      publishDiscoveryCsatOutcomeFact(eventStore, context, {
        outcomeCode: "registration.completed",
        subjectAccountId: "acc_buyer",
        subjectKind: "account",
        subject: { entityType: "account", entityId: "acc_buyer" },
        idempotencyKey: "identity:registration:acc_buyer",
      }),
    ).rejects.toThrow("not owned by discovery");
  });
});
