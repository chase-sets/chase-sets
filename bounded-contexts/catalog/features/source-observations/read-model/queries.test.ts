import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  listSourceObservationIdsForPromotion,
  previewSourceObservationPromotionScope,
} from "./queries";

describe("source observation read-model queries", () => {
  it("previews no eligible observations when the current status filter is terminal", async () => {
    const db = queryable([{ count: "7" }]);

    const preview = await previewSourceObservationPromotionScope(db, {
      status: "promoted",
      language: "en",
      setId: "base1",
    });

    expect(preview).toMatchObject({
      matched: 7,
      eligible: 0,
      terminal: 7,
      scope: {
        status: "promoted",
        language: "en",
        setId: "base1",
      },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("lists eligible observed IDs across the whole matching filter scope", async () => {
    const db = queryable([
      { observation_id: "obs_2" },
      { observation_id: "obs_1" },
    ]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      search: "charizard",
      language: "en",
      setId: "base1",
    });

    expect(ids).toEqual(["obs_2", "obs_1"]);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY observed_at DESC"),
      ["en", "base1", "observed", "%charizard%"],
    );
  });

  it("does not query IDs when the current status filter is terminal", async () => {
    const db = queryable([]);

    await expect(
      listSourceObservationIdsForPromotion(db, { status: "rejected" }),
    ).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

function queryable(rows: readonly Record<string, unknown>[]): PgQueryable {
  return {
    query: vi.fn(async () => ({
      rows: [...rows],
      rowCount: rows.length,
    })),
  };
}
