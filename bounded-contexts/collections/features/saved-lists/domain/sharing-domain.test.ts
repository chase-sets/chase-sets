import { describe, expect, it } from "vitest";
import { applyEvents } from "@chase-sets/event-core";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListCommandId, SavedListId } from "./contracts";
import {
  decideSavedListSharing,
  evolveSavedListSharing,
  initialSavedListSharingState,
  toSavedListSharingSnapshot,
} from "./sharing-domain";

const listId = "svl_sharing" as SavedListId;
const ownerAccountId = "acc_owner" as AccountId;
const commandId = (value: string) => `slc_${value}` as SavedListCommandId;

describe("Saved List sharing domain", () => {
  it("replays private disclosure defaults, independent controls, rotation, and revocation", () => {
    const configured = decideSavedListSharing(initialSavedListSharingState, {
      type: "ConfigureSavedListSharing",
      commandId: commandId("configure"),
      listId,
      ownerAccountId,
      configuredAt: "2026-07-13T12:00:00.000Z",
    });
    let state = applyEvents(initialSavedListSharingState, evolveSavedListSharing, configured);
    expect(toSavedListSharingSnapshot(state, 1)).toMatchObject({
      disclosure: { showTrackedQuantities: false, showCurrentEstimatedValue: false },
      unlistedAccess: { active: false, generation: 0 },
    });

    const disclosed = decideSavedListSharing(state, {
      type: "ChangeSavedListDisclosure",
      commandId: commandId("disclose"),
      disclosure: { showTrackedQuantities: true, showCurrentEstimatedValue: false },
      changedAt: "2026-07-13T12:01:00.000Z",
    });
    state = applyEvents(state, evolveSavedListSharing, disclosed);
    const rotated = decideSavedListSharing(state, {
      type: "RotateSavedListUnlistedAccess",
      commandId: commandId("rotate"),
      keyId: "primary",
      verifier: `sha256:${"a".repeat(64)}`,
      rotatedAt: "2026-07-13T12:02:00.000Z",
    });
    state = applyEvents(state, evolveSavedListSharing, rotated);
    const revoked = decideSavedListSharing(state, {
      type: "RevokeSavedListUnlistedAccess",
      commandId: commandId("revoke"),
      revokedAt: "2026-07-13T12:03:00.000Z",
    });
    state = applyEvents(state, evolveSavedListSharing, revoked);

    expect(toSavedListSharingSnapshot(state, 4)).toMatchObject({
      disclosure: { showTrackedQuantities: true, showCurrentEstimatedValue: false },
      unlistedAccess: { active: false, generation: 2 },
    });
    expect([...configured, ...disclosed, ...rotated, ...revoked].map((event) => event.type)).toEqual([
      "collections.saved-list-sharing.configured",
      "collections.saved-list-sharing.disclosure-changed",
      "collections.saved-list-sharing.unlisted-access-rotated",
      "collections.saved-list-sharing.unlisted-access-revoked",
    ]);
  });
});
