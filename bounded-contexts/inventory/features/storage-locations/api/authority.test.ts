import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createStorageLocationAuthority } from "./authority";
import { listStorageLocations } from "../read-model/queries";

const stores = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => stores.current,
}));

describe("Storage Location Authority", () => {
  it.each([
    null,
    [],
    {},
    { accountId: "owner", storageLocationId: { id: "location" } },
    { accountId: { id: "owner" }, storageLocationId: "location" },
    { accountId: "owner", storageLocationId: "location", revision: 1 },
    { accountId: "", storageLocationId: "location" },
  ])("closes authority input before any stream read: %j", async (input) => {
    const loadStream = vi.fn();
    stores.current = { loadStream };
    const query = vi.fn();
    const authority = createStorageLocationAuthority({ query, connect: query });
    await expect(authority.resolveStorageLocationAuthority(input as never)).rejects.toThrow(
      "Invalid storage location authority input.",
    );
    expect(loadStream).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("reads ownership, archive state and committed revision without consulting a projection", async () => {
    const memory = createInMemoryEventStore();
    stores.current = memory.eventStore;
    const query = vi.fn(async (): Promise<never> => {
      throw new Error("projection must not be read");
    });
    const authority = createStorageLocationAuthority({ query, connect: query });
    const context = {
      tenantId: "tenant" as never,
      audit: { performedByUserId: "user" as never, forAccountId: "owner" as never },
    };
    await memory.eventStore.appendToStream({
      streamId: "inventory.storage-location-location",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "inventory.storage-location.created",
          payload: {
            storageLocationId: "location",
            accountId: "owner",
            name: "Shelf",
            description: null,
            shipFromCode: "shelf",
            shipFromAddress: null,
          },
        },
      ],
    });
    expect(
      await authority.resolveStorageLocationAuthority({ accountId: "owner", storageLocationId: "location" }),
    ).toEqual({ accountId: "owner", storageLocationId: "location", revision: 1, status: "active" });
    expect(
      await authority.resolveStorageLocationAuthority({ accountId: "foreign", storageLocationId: "location" }),
    ).toBeNull();
    expect(
      await authority.resolveStorageLocationAuthority({ accountId: "owner", storageLocationId: "missing" }),
    ).toBeNull();
    await memory.eventStore.appendToStream({
      streamId: "inventory.storage-location-location",
      expectedVersion: 1,
      context,
      events: [{ eventType: "inventory.storage-location.archived", payload: { storageLocationId: "location" } }],
    });
    expect(
      await authority.resolveStorageLocationAuthority({ accountId: "owner", storageLocationId: "location" }),
    ).toEqual({ accountId: "owner", storageLocationId: "location", revision: 2, status: "retired" });
    expect(query).not.toHaveBeenCalled();
  });

  it("bounds the setup read at SQL, scopes by account, and leaves existing unbounded callers unchanged", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    await listStorageLocations({ query }, { accountId: "owner", includeArchived: false, limit: 250 });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("account_id = $1 AND is_archived = false"), [
      "owner",
      250,
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("LIMIT $2");
    await listStorageLocations({ query }, { accountId: "owner", includeArchived: true });
    expect(query).toHaveBeenLastCalledWith(expect.not.stringContaining("LIMIT"), ["owner"]);
    for (const limit of [0, -1, 251, 1.5, Number.NaN]) {
      await expect(listStorageLocations({ query }, { accountId: "owner", limit })).rejects.toThrow(
        "Invalid storage location limit.",
      );
    }
    expect(query).toHaveBeenCalledTimes(2);
  });
});
