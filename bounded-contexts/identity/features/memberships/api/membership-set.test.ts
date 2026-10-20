import { describe, expect, it } from "vitest";
import { createInMemoryEventStore as createStore } from "../../../tests/in-memory-event-store";
import { createIdentityBootstrapContext } from "../../../support/runtime-support/bootstrap-context";
import { planMembershipSetAppends, readUserMembershipSet } from "./membership-set";

const context = createIdentityBootstrapContext();
const streamId = "identity.membership-mbr_set_test";
const grant = {
  eventType: "identity.membership.granted",
  payload: { membershipId: "mbr_set_test", userId: "usr_set_test", accountId: "acc_set_test", roleKey: "owner" },
};

function createInMemoryEventStore() {
  const store = createStore();
  return { ...store, readVersion: async (id: string) => store.streams.get(id)?.length ?? 0 };
}

describe("User Membership Set atomic authority", () => {
  it("records grant, role, revoke and reinstate in the same expected-version batch", async () => {
    const store = createInMemoryEventStore();
    for (const [version, event] of [
      grant,
      { eventType: "identity.membership.role-changed", payload: { roleKey: "manager" } },
      { eventType: "identity.membership.revoked", payload: {} },
      { eventType: "identity.membership.reinstated", payload: {} },
    ].entries()) {
      const inputs = await planMembershipSetAppends(store, [
        { streamId, expectedVersion: version, context, events: [event] },
      ]);
      expect(inputs).toHaveLength(2);
      await store.appendToStreams!(inputs);
    }
    const set = await readUserMembershipSet(store, "usr_set_test", context.tenantId);
    expect(set.version).toBe(4);
    expect(set.memberships).toEqual([
      expect.objectContaining({
        membershipId: "mbr_set_test",
        accountId: "acc_set_test",
        roleKey: "manager",
        status: "active",
        sourceRevision: 4,
      }),
    ]);
  });

  it("a Set race rolls back the source fact too", async () => {
    const store = createInMemoryEventStore();
    const inputs = await planMembershipSetAppends(store, [{ streamId, expectedVersion: 0, context, events: [grant] }]);
    await store.appendToStream(inputs[1]);
    await expect(store.appendToStreams!(inputs)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await store.readStream({ streamId })).toEqual([]);
  });

  it("reconciles 500/501 revisions without a cap or duplicate import", async () => {
    const store = createInMemoryEventStore();
    await store.appendToStream({ streamId, expectedVersion: 0, context, events: [grant] });
    for (let revision = 2; revision <= 501; revision++) {
      await store.appendToStream({
        streamId,
        expectedVersion: revision - 1,
        context,
        events: [
          {
            eventType: revision % 2 === 0 ? "identity.membership.revoked" : "identity.membership.reinstated",
            payload: {},
          },
        ],
      });
    }
    const guard = { streamId, expectedVersion: 501, context, events: [] };
    await store.appendToStreams!(await planMembershipSetAppends(store, [guard], { reconcile: true }));
    const again = await planMembershipSetAppends(store, [guard], { reconcile: true });
    expect(again).toHaveLength(1);
    expect((await readUserMembershipSet(store, "usr_set_test", context.tenantId)).memberships[0].sourceRevision).toBe(
      501,
    );
  });

  it("blocks poisoned source identity instead of adopting it", async () => {
    const store = createInMemoryEventStore();
    await expect(
      planMembershipSetAppends(store, [
        {
          streamId,
          expectedVersion: 0,
          context,
          events: [{ ...grant, payload: { ...grant.payload, membershipId: "mbr_other" } }],
        },
      ]),
    ).rejects.toThrow("MEMBERSHIP_SET_UNKNOWN");
    expect(store.streams.size).toBe(0);
  });

  it("blocks a truncated page using the independent source head", async () => {
    const store = createInMemoryEventStore();
    await store.appendToStream({ streamId, expectedVersion: 0, context, events: [grant] });
    const input = { streamId, expectedVersion: 1, context, events: [] };
    const truncated = { ...store, readStream: async () => [] };
    await expect(planMembershipSetAppends(truncated, [input], { reconcile: true })).rejects.toThrow(
      "truncated or concurrently changed history",
    );
    await expect(planMembershipSetAppends(store, [input], { reconcile: true })).resolves.toHaveLength(2);
  });

  it.each([
    { ...grant, payload: { ...grant.payload, unknown: { nested: true } } },
    { ...grant, payload: { ...grant.payload, roleKey: "unrecognized" } },
    { eventType: "identity.membership.reinstated", payload: {} },
  ])("blocks closed-schema and terminal-history poison: $eventType", async (event) => {
    const store = createInMemoryEventStore();
    await expect(
      planMembershipSetAppends(store, [{ streamId, expectedVersion: 0, context, events: [event] }]),
    ).rejects.toThrow("MEMBERSHIP_SET_UNKNOWN");
    expect(store.streams.size).toBe(0);
  });

  it("blocks a valid-looking but mismatched Set fact before another write", async () => {
    const store = createInMemoryEventStore();
    const inputs = await planMembershipSetAppends(store, [{ streamId, expectedVersion: 0, context, events: [grant] }]);
    await store.appendToStreams!(inputs);
    const setId = inputs[1].streamId;
    const [recorded] = store.streams.get(setId)!;
    store.streams.set(setId, [{ ...recorded, payload: { ...recorded.payload, accountId: "acc_other" } }]);
    await expect(
      planMembershipSetAppends(store, [
        { streamId, expectedVersion: 1, context, events: [{ eventType: "identity.membership.revoked", payload: {} }] },
      ]),
    ).rejects.toThrow("source-to-Set mismatch");
    expect(store.streams.get(streamId)).toHaveLength(1);
  });
});
