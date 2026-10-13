import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createAccountRuntime } from "../../accounts/api/runtime";
import { createUserRuntime } from "../../users/api/runtime";
import { createMembershipRuntime } from "../../memberships/api/runtime";
import type { IdentityServices } from "../../../support/runtime-support/services";
import { bootstrapPlatformAdminIdentity } from "../../../support/runtime-support/production-bootstrap";

describe("issue-7168-ac11-caller-compatibility", () => {
  it("boots twice against authoritative histories while every projection still lags", async () => {
    const memory = createInMemoryEventStore();
    const db = { query: async () => ({ rows: [] }) };
    const deps = { eventStore: memory.eventStore, checkpointStore: createPostgresProjectionStore({ db }), db };
    const services = {
      eventStore: memory.eventStore,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      db: deps.db,
      projectors: [],
    } as unknown as IdentityServices;
    const config = {
      email: "synthetic-bootstrap@example.test",
      displayName: "Synthetic Bootstrap",
      accountName: "Synthetic Platform",
    };
    await bootstrapPlatformAdminIdentity(services, config);
    const count = memory.allEvents.length;
    expect(await bootstrapPlatformAdminIdentity(services, config)).toMatchObject({
      createdAccount: false,
      createdUser: false,
      createdMembership: false,
      repairedMembershipRole: false,
    });
    expect(memory.allEvents).toHaveLength(count);
  });
});
