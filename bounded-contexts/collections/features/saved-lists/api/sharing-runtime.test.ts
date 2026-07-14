import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListCommandId, SavedListId, SavedListOwnerSnapshot } from "../domain/contracts";
import { createSavedListCapabilityService } from "../domain/unlisted-capability";
import {
  createSavedListSharingRuntime,
  SavedListSharingAuthorizationError,
  SavedListSharingConcurrencyConflictError,
} from "./sharing-runtime";

const listId = "svl_runtime" as SavedListId;
const ownerAccountId = "acc_owner" as AccountId;
const commandId = (value: string) => `slc_${value}` as SavedListCommandId;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: ownerAccountId },
};
const ownerSnapshot: SavedListOwnerSnapshot = {
  contractVersion: 1,
  identity: { listId, ownerAccountId },
  title: "Trade targets",
  description: null,
  visibility: "private",
  lifecycle: "active",
  cover: null,
  membership: { orderedLineIds: [], lineCount: 0, trackedUnitCount: 0 },
  lines: [],
  createdAt: "2026-07-13T12:00:00.000Z",
  changedAt: "2026-07-13T12:00:00.000Z",
  archivedAt: null,
  version: 1,
};

function setup() {
  const store = createInMemoryEventStore();
  const capabilities = createSavedListCapabilityService({
    activeKeyId: "primary",
    keys: [{ id: "primary", secret: "runtime-capability-key-material!!" }],
  });
  const runtime = createSavedListSharingRuntime({
    eventStore: store.eventStore,
    ownerSnapshots: { getOwnerSnapshot: async () => ownerSnapshot },
    capabilities,
    clock: () => "2026-07-13T12:30:00.000Z",
  });
  return { ...store, capabilities, runtime };
}

describe("Saved List sharing runtime", () => {
  it("rotates and revokes an idempotent unlisted secret without persisting the raw secret", async () => {
    const { runtime, allEvents } = setup();
    const input = { commandId: commandId("rotate"), listId, ownerAccountId, expectedVersion: 0 };
    const first = await runtime.rotateUnlistedAccess(input, context);
    const replay = await runtime.rotateUnlistedAccess(input, context);

    expect(first.unlistedSecret).toBeTruthy();
    expect(replay.unlistedSecret).toBe(first.unlistedSecret);
    expect(replay.receipt.replayed).toBe(true);
    expect(first.sharing.unlistedAccess).toMatchObject({ active: true, generation: 1 });
    expect(JSON.stringify(allEvents)).not.toContain(first.unlistedSecret as string);

    const revoked = await runtime.revokeUnlistedAccess(
      { commandId: commandId("revoke"), listId, ownerAccountId, expectedVersion: first.sharing.version },
      context,
    );
    expect(revoked.sharing.unlistedAccess).toMatchObject({ active: false, generation: 2 });
  });

  it("enforces owner audit context and sharing expected versions", async () => {
    const { runtime } = setup();
    const first = await runtime.changeDisclosure(
      {
        commandId: commandId("disclose"),
        listId,
        ownerAccountId,
        expectedVersion: 0,
        disclosure: { showTrackedQuantities: false, showCurrentEstimatedValue: true },
      },
      context,
    );
    expect(first.sharing.disclosure).toEqual({ showTrackedQuantities: false, showCurrentEstimatedValue: true });
    await expect(
      runtime.changeDisclosure(
        {
          commandId: commandId("stale"),
          listId,
          ownerAccountId,
          expectedVersion: 0,
          disclosure: { showTrackedQuantities: true, showCurrentEstimatedValue: true },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(SavedListSharingConcurrencyConflictError);
    await expect(
      runtime.getSharing(
        { listId, ownerAccountId },
        { ...context, audit: { ...context.audit, forAccountId: "acc_other" as AccountId } },
      ),
    ).rejects.toBeInstanceOf(SavedListSharingAuthorizationError);
  });
});
