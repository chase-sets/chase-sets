import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IdentityMutationPersistence, IdentityMutationTransaction } from "../../../account-management/api/fences";
import { validateOwnerHistory } from "../../../account-management/api/owners";
import { buildProfileRedactionReactionHandlers } from "./profile-redaction-reaction";

const actionType = "platform-operations.reported-content.action-recorded";
const accountId = createId("acc");
const operatorUserId = createId("usr");
const context: EventStoreContext = {
  tenantId: createId("tnt"),
  audit: { performedByUserId: operatorUserId, forAccountId: createId("acc") },
};
const streamId = `identity.account-${accountId}`;
const privateMarker = "account-profile-marker-scan";
const originalDisplayName = `Former ${privateMarker}`;
const originalName = "Seller LLC";
const createdAt = "2026-11-20T01:00:00.000Z";
const actionAt = "2026-11-20T02:00:00.000Z";
const editAt = "2026-11-20T03:00:00.000Z";

function action(overrides: Record<string, unknown> = {}) {
  return buildTransportEvent(
    actionType,
    {
      actionId: createId("rca"),
      action: "redact-profile-display-name",
      targetType: "account-profile",
      targetId: accountId,
      operatorUserId,
      note: `Operator note ${privateMarker}`,
      recordedAt: actionAt,
      ...overrides,
    },
    { tenantId: context.tenantId, audit: context.audit },
  );
}

async function fixture() {
  const store = createInMemoryEventStore();
  const events = () => store.streams.get(streamId) ?? [];
  const append = vi.fn<IdentityMutationTransaction["append"]>((inputs) => store.eventStore.appendToStreams!(inputs));
  const transaction: IdentityMutationPersistence["transaction"] = async (_scopes, work) =>
    work({
      db: {} as never,
      append,
      read: async () => events().map((event) => ({ ...event, recordedAt: event.occurredAt })),
      projectionPredicate: async () => [],
    });
  const handler = buildProfileRedactionReactionHandlers({ transaction })[actionType]!;
  await store.eventStore.appendToStream({
    streamId,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "identity.account.created",
        occurredAt: parseIsoUtcTimestamp(createdAt),
        payload: { accountId, accountType: "business", name: originalName, displayName: originalDisplayName },
      },
    ],
  });
  const update = (displayName: string) =>
    store.eventStore.appendToStream({
      streamId,
      expectedVersion: events().length,
      context,
      events: [
        {
          eventType: "identity.account.profile-updated",
          occurredAt: parseIsoUtcTimestamp(editAt),
          payload: { name: originalName, displayName },
        },
      ],
    });
  return { events, update, append, handler, eventStore: store.eventStore };
}

describe("Account Profile display-name redaction", () => {
  it("appends the audit and ordinary profile fact together, keeps status, and does not reapply after a newer edit", async () => {
    const f = await fixture();
    const recorded = action();
    const { actionId } = recorded.data;
    await f.handler(recorded);
    await f.handler(recorded);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append.mock.calls[0][0]).toMatchObject([{ streamId, expectedVersion: 1 }]);
    const [, record, profile] = f.events();
    expect(record).toMatchObject({
      eventType: "identity.account.display-name-redacted",
      payload: { actionId, operatorUserId },
    });
    expect(record.payload).toEqual({ actionId, operatorUserId });
    expect(toTransportEvent(profile)).toMatchObject({
      type: "identity.account.profile-updated",
      data: { name: originalName, displayName: "Name removed" },
    });
    expect(validateOwnerHistory("account", f.events(), context.tenantId)).toMatchObject({
      state: { displayName: "Name removed", status: "active", name: originalName },
    });
    await f.update("Replacement");
    await f.handler(recorded);
    expect(f.events()).toHaveLength(4);
    expect(f.events().at(-1)?.payload.displayName).toBe("Replacement");
    expect(f.append).toHaveBeenCalledTimes(1);
  });

  it("ignores stale actions but not an intervening legal-name-only update", async () => {
    const changed = await fixture();
    await changed.update("Replacement");
    await changed.handler(action());
    expect(changed.append).not.toHaveBeenCalled();
    expect(changed.events().at(-1)?.payload.displayName).toBe("Replacement");

    const carried = await fixture();
    await carried.update(originalDisplayName);
    await carried.handler(action());
    expect(carried.events().at(-1)?.payload.displayName).toBe("Name removed");
  });

  it("does not dispatch other actions or targets or operator-less actions", async () => {
    const f = await fixture();
    for (const other of [
      action({ action: "dismiss" }),
      action({ action: "contact-account" }),
      action({ action: "escalate-account-suspension" }),
      action({ targetType: "listing", action: "unlist", targetId: "listing-test" }),
      action({ targetType: "review", action: "redact-review-feedback", targetId: "review-test" }),
      action({ operatorUserId: null }),
      action({ operatorUserId: createId("usr") }),
    ])
      await f.handler(other);
    expect(f.append).not.toHaveBeenCalled();
  });

  it("a racing owner edit wins the expected-version append and retry", async () => {
    const f = await fixture();
    const recorded = action();
    f.append.mockImplementationOnce(async (inputs) => {
      await f.update("Newer owner name");
      return f.eventStore.appendToStreams!(inputs);
    });
    await expect(f.handler(recorded)).rejects.toThrow(/^profile_redaction_unavailable$/);
    await f.handler(recorded);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.events()).toHaveLength(2);
    expect(f.events().at(-1)?.payload.displayName).toBe("Newer owner name");
  });

  it("account-profile-marker-scan: a failed redaction exposes only the closed code", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.append.mockRejectedValueOnce(new Error(privateMarker));
    try {
      await expect(f.handler(action())).rejects.toThrow(/^profile_redaction_unavailable$/);
      expect(f.events()).toHaveLength(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateMarker);
    } finally {
      log.mockRestore();
    }
  });
});
