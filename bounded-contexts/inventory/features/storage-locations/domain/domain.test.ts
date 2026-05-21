import { describe, expect, it } from "vitest";
import { decideStorageLocation, evolveStorageLocation, initialStorageLocationState } from "./domain";

describe("storage location domain", () => {
  it("creates and archives a storage location", async () => {
    const created = await decideStorageLocation(initialStorageLocationState, {
      type: "CreateStorageLocation",
      storageLocationId: "loc_1" as never,
      accountId: "acc_1" as never,
      name: "North shelf",
      description: "Singles",
      shipFromCode: "CHI-WH-1",
      shipFromAddress: {
        name: "North shelf shipping",
        line1: "100 Test Lane",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
    });
    const createdState = created.reduce(evolveStorageLocation, initialStorageLocationState);
    const archived = await decideStorageLocation(createdState, {
      type: "ArchiveStorageLocation",
    });
    const archivedState = archived.reduce(evolveStorageLocation, createdState);

    expect(createdState.name).toBe("North shelf");
    expect(createdState.shipFromAddress?.line1).toBe("100 Test Lane");
    expect(archivedState.isArchived).toBe(true);
  });
});
