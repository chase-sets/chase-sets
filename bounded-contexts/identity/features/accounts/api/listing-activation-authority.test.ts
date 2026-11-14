import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  createInMemoryConfigurationEpochStore,
  createInMemoryConfigurationConsumer,
} from "@chase-sets/event-core/test-support";
import type { IdentityMutationPersistence } from "../../account-management/api/fences";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { createIdentityListingActivationAuthority } from "./listing-activation-authority";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const input = {
  tenantId: context.tenantId,
  accountId: "acc_synthetic",
  userId: "usr_synthetic",
  membershipId: "mem_synthetic",
  consumer: { storeId: "marketplace", incarnation: "synthetic-consumer" },
};

async function fixture(roleKey = "owner") {
  const { eventStore } = createInMemoryEventStore();
  const source = createInMemoryConfigurationEpochStore("synthetic-identity");
  const consumer = createInMemoryConfigurationConsumer(input.consumer);
  const events = [
    [
      "account",
      input.accountId,
      "created",
      { accountId: input.accountId, accountType: "personal", name: "Test", displayName: "Test" },
    ],
    [
      "user",
      input.userId,
      "created",
      { userId: input.userId, displayName: "Test", givenName: "", familyName: "", primaryEmail: null },
    ],
    [
      "membership",
      input.membershipId,
      "granted",
      { membershipId: input.membershipId, accountId: input.accountId, userId: input.userId, roleKey },
    ],
  ] as const;
  for (const [kind, id, event, payload] of events) {
    await eventStore.appendToStream({
      streamId: `identity.${kind}-${id}`,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: `identity.${kind}.${event}`, payload }],
    });
    source.open(`${kind}/${id}`);
    source.registerConsumer(`${kind}/${id}`, consumer);
  }
  const poison = vi.fn(() => {
    throw new Error("projection or snapshot was read");
  });
  const read = vi.fn(async (streamId: string): Promise<readonly StoredEvent[]> => eventStore.readStream({ streamId }));
  const persistence: IdentityMutationPersistence = {
    eventStore,
    transaction: async (_scopes, work) =>
      work({
        db: { query: async () => ({ rows: [] }) },
        read,
        append: poison,
        projectionPredicate: poison,
      }),
  };
  const authority = createIdentityListingActivationAuthority(persistence, {
    source: async () => ({
      captureGrantInTransaction: async (_db, key, target) => source.captureGrant(key, target),
      registerConsumer: async () => {
        throw new Error("unexpected topology mutation");
      },
    }),
  });
  // Unrelated caches are deliberately hostile and never supplied as authority.
  Object.assign(persistence, { snapshotStore: { loadLatest: poison }, getAccount: poison, getMembership: poison });
  return { authority, eventStore, source, poison, read };
}

describe("Listing Activation Authority canonical class-C capture", () => {
  it.each(["owner", "manager"])("grants %s from exactly three canonical aggregates and seals", async (role) => {
    const f = await fixture(role);
    const result = await f.authority.capture(input);
    expect(result.kind).toBe("granted");
    if (result.kind !== "granted") throw new Error("expected grant");
    expect(result.membership.state.roleKey).toBe(role);
    expect(result.account.seal).toEqual({ version: 1, storeIncarnation: "synthetic-identity" });
    expect(result.grants.map((grant) => grant.key)).toEqual([
      "account/acc_synthetic",
      "user/usr_synthetic",
      "membership/mem_synthetic",
    ]);
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.poison).not.toHaveBeenCalled();
  });
  it.each(["viewer", "fulfillment", "platform-admin"])(
    "refuses role %s regardless of projected permissions",
    async (role) => {
      expect((await (await fixture(role)).authority.capture(input)).kind).toBe("denied");
    },
  );
  it.each(["account", "user", "membership"])("refuses a pending %s key", async (kind) => {
    const f = await fixture();
    const id = kind === "account" ? input.accountId : kind === "user" ? input.userId : input.membershipId;
    f.source.beginClosure(`${kind}/${id}`);
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });
  it.each([
    { tenantId: "tnt_foreign" },
    { accountId: "acc_foreign" },
    { userId: "usr_foreign" },
    { membershipId: "mem_absent" },
  ])("refuses foreign/absent authority %j", async (change) => {
    expect((await (await fixture()).authority.capture({ ...input, ...change })).kind).toBe("denied");
  });
  it.each(["account", "user", "membership"])("refuses inactive %s", async (kind) => {
    const f = await fixture();
    const id = kind === "account" ? input.accountId : kind === "user" ? input.userId : input.membershipId;
    await f.eventStore.appendToStream({
      streamId: `identity.${kind}-${id}`,
      expectedVersion: 1,
      context,
      events: [{ eventType: `identity.${kind}.${kind === "membership" ? "revoked" : "suspended"}`, payload: {} }],
    });
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });
  it("refuses the wrong exact user-account binding and partial history", async () => {
    const f = await fixture();
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (streamId) =>
      (await original(streamId)).map((event) =>
        streamId.includes("membership-") ? { ...event, payload: { ...event.payload, userId: "usr_foreign" } } : event,
      ),
    );
    expect((await f.authority.capture(input)).kind).toBe("denied");
    f.read.mockImplementation(async (streamId) =>
      (await original(streamId)).map((event) => ({ ...event, streamVersion: 2 })),
    );
    expect((await f.authority.capture(input)).kind).toBe("denied");
  });
});
