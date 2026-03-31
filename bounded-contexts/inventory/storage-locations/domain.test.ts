import { describe, expect, it } from "vitest";
import {
  decideStorageLocation,
  evolveStorageLocation,
  initialStorageLocationState,
} from "./domain";

describe("storage location domain", () => {
  it("creates and archives a storage location", async () => {
    const created = await decideStorageLocation(initialStorageLocationState, {
      type: "CreateStorageLocation",
      storageLocationId: "loc_1" as never,
      accountId: "acc_1" as never,
      name: "North shelf",
      description: "Singles",
      shipFromCode: "CHI-WH-1",
    });
    const createdState = created.reduce(evolveStorageLocation, initialStorageLocationState);
    const archived = await decideStorageLocation(createdState, {
      type: "ArchiveStorageLocation",
    });
    const archivedState = archived.reduce(evolveStorageLocation, createdState);

    expect(createdState.name).toBe("North shelf");
    expect(archivedState.isArchived).toBe(true);
  });
});
