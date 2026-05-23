import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  listSourceObservationIdsForReapply,
  listSourceObservationIdsForPromotion,
  listSourceObservationIntegrationScopes,
  previewSourceObservationReapplyScope,
  previewSourceObservationPromotionScope,
} from "./queries";

describe("source observation read-model queries", () => {
  it("previews promoted observations as eligible for explicit promotion resync", async () => {
    const db = queryableSequence([[{ count: "7" }], [{ count: "7" }]]);

    const preview = await previewSourceObservationPromotionScope(db, {
      status: "promoted",
      language: "en",
      setId: "base1",
    });

    expect(preview).toMatchObject({
      matched: 7,
      eligible: 7,
      terminal: 0,
      scope: {
        status: "promoted",
        language: "en",
        setId: "base1",
      },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = ANY"), ["en", "base1", ["promoted"]]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = $3"), ["en", "base1", "promoted"]);
  });

  it("lists eligible observed and changed IDs across the whole matching filter scope", async () => {
    const db = queryable([{ observation_id: "obs_2" }, { observation_id: "obs_1" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      search: "charizard",
      language: "en",
      setId: "base1",
    });

    expect(ids).toEqual(["obs_2", "obs_1"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), [
      "en",
      "base1",
      ["observed", "changed"],
      "%charizard%",
    ]);
  });

  it("lists only changed IDs when the current status filter is changed", async () => {
    const db = queryable([{ observation_id: "obs_changed" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      status: "changed",
      language: "en",
    });

    expect(ids).toEqual(["obs_changed"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), ["en", ["changed"]]);
  });

  it("lists promoted IDs when the current status filter is promoted", async () => {
    const db = queryable([{ observation_id: "obs_promoted" }]);

    const ids = await listSourceObservationIdsForPromotion(db, {
      status: "promoted",
      language: "en",
    });

    expect(ids).toEqual(["obs_promoted"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), ["en", ["promoted"]]);
  });

  it("does not query IDs when the current status filter is terminal", async () => {
    const db = queryable([]);

    await expect(listSourceObservationIdsForPromotion(db, { status: "rejected" })).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("previews promoted observations as eligible for reapply", async () => {
    const db = queryableSequence([[{ count: "7" }], [{ count: "12" }]]);

    const preview = await previewSourceObservationReapplyScope(db, {
      language: "en",
      setId: "base1",
    });

    expect(preview).toMatchObject({
      matched: 12,
      eligible: 7,
      ineligible: 5,
      scope: {
        language: "en",
        setId: "base1",
      },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("COUNT(*)"), ["en", "base1"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = ANY"), ["en", "base1", ["promoted"]]);
  });

  it("lists promoted IDs across the whole matching reapply scope", async () => {
    const db = queryable([{ observation_id: "obs_promoted_2" }, { observation_id: "obs_promoted_1" }]);

    const ids = await listSourceObservationIdsForReapply(db, {
      search: "abra",
      language: "en",
      setId: "base1",
    });

    expect(ids).toEqual(["obs_promoted_2", "obs_promoted_1"]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY observed_at DESC"), [
      "en",
      "base1",
      ["promoted"],
      "%abra%",
    ]);
  });

  it("does not query reapply IDs when the current status filter is not promoted", async () => {
    const db = queryable([]);

    await expect(listSourceObservationIdsForReapply(db, { status: "changed" })).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("summarizes pulled provider scopes by language expansion and series", async () => {
    const db = queryable([
      {
        provider_key: "tcgdex",
        language_code: "en",
        expansion_id: "base1",
        expansion_name: "Base Set",
        series_id: "base",
        series_name: "Base",
        total_observations: 102,
        observed_observations: 100,
        changed_observations: 1,
        promoted_observations: 1,
        rejected_observations: 1,
        first_observed_at: "2026-05-16T00:00:00.000Z",
        latest_observed_at: "2026-05-16T00:01:00.000Z",
        latest_source_updated_at: null,
      },
    ]);

    const scopes = await listSourceObservationIntegrationScopes(db, {
      provider: "tcgdex",
      language: "en",
      setId: "base1",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      provider_key: "tcgdex",
      language_code: "en",
      expansion_id: "base1",
      series_name: "Base",
      total_observations: 102,
      observed_observations: 100,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("GROUP BY"), ["tcgdex", "en", "base1"]);
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

function queryableSequence(results: readonly (readonly Record<string, unknown>[])[]): PgQueryable {
  let index = 0;

  return {
    query: vi.fn(async () => {
      const rows = results[Math.min(index, results.length - 1)] ?? [];
      index += 1;
      return {
        rows: [...rows],
        rowCount: rows.length,
      };
    }),
  };
}
