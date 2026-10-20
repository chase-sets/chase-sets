import { describe, expect, it, vi } from "vitest";
import { assertOwnerStreamVersions } from "./owner-seal";

const reservation = {
  ownerContext: "identity",
  streamId: "identity.account-acc_1",
  expectedVersion: 2,
  assertCurrent: vi.fn(async () => undefined),
};

describe("owner stream PostgreSQL fence", () => {
  it("locks and validates each captured stream revision", async () => {
    const query = vi.fn(async () => ({ rows: [{ current_version: "2" }] }));
    await assertOwnerStreamVersions({ query } as never, [reservation]);
    expect(query).toHaveBeenCalledWith(
      "SELECT current_version FROM event_store_streams WHERE stream_id = $1 FOR SHARE",
      [reservation.streamId],
    );
  });

  it("refuses missing or changed streams and unsafe SQL identifiers", async () => {
    await expect(
      assertOwnerStreamVersions({ query: vi.fn(async () => ({ rows: [] })) } as never, [reservation]),
    ).rejects.toThrow("Owner stream version changed");
    await expect(
      assertOwnerStreamVersions({ query: vi.fn() } as never, [reservation], "event_store_streams;DROP TABLE x"),
    ).rejects.toThrow("table identifier is invalid");
  });
});
