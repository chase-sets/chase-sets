import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { countActiveOwnersForAccount } from "./queries";

describe("membership queries", () => {
  it("counts only active owner memberships for the account", async () => {
    const query = vi.fn(async () => ({ rows: [{ count: "2" }] }));

    await expect(countActiveOwnersForAccount({ query } as PgQueryable, "acc_team")).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/role_key = 'owner'[\s\S]*status = 'active'/), [
      "acc_team",
    ]);
  });
});
