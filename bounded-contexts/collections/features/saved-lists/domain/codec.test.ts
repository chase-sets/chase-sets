import { describe, expect, it } from "vitest";
import { upcastSavedListEvent } from "./codec";

describe("Saved List event codec", () => {
  it("upcasts native pre-version payloads to v1", () => {
    expect(
      upcastSavedListEvent({
        eventType: "collections.saved-list.created",
        payload: {
          commandId: "slc_create",
          listId: "svl_one",
          ownerAccountId: "acc_owner",
          title: "Trade targets",
          description: null,
          visibility: "private",
          createdAt: "2026-07-13T12:00:00.000Z",
        },
      }),
    ).toEqual({
      type: "collections.saved-list.created",
      data: expect.objectContaining({ eventSchemaVersion: 1, listId: "svl_one" }),
    });
  });

  it("fails visibly for future schemas and unknown event types", () => {
    expect(() =>
      upcastSavedListEvent({
        eventType: "collections.saved-list.created",
        payload: { eventSchemaVersion: 2 },
      }),
    ).toThrow("Unsupported Saved List event schema version '2'");
    expect(() => upcastSavedListEvent({ eventType: "collections.saved-list.unknown", payload: {} })).toThrow(
      "Unrecognized Saved List event type",
    );
  });
});
