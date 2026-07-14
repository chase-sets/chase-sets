import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { describe, expect, it, vi } from "vitest";
import type { SavedListId } from "../../saved-lists/domain";
import { createSavedListValuationRuntime } from "./runtime";

const listId = "svl_one" as SavedListId;
const ownerAccountId = "acc_owner" as AccountId;

function dbWithRows(
  input: Readonly<{ visibility?: "private" | "unlisted" | "public"; lifecycle?: "active" | "archived" }>,
) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          list_id: listId,
          owner_account_id: ownerAccountId,
          visibility: input.visibility ?? "private",
          lifecycle: input.lifecycle ?? "active",
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          line_id: "sll_one",
          catalog_catalog_item_id: "cat_one",
          product_id: "prd_one",
          tracked_quantity: 2,
          estimate_version: "estimate-1",
          window_started_at: "2026-07-01T00:00:00.000Z",
          window_ended_at: "2026-07-13T10:00:00.000Z",
          amount: "5.00",
          currency_code: "usd",
          band_low_amount: "4.00",
          band_high_amount: "6.00",
          confidence: "high",
          estimated_at: "2026-07-13T10:00:00.000Z",
          fresh_until: "2026-07-14T10:00:00.000Z",
          disclosure: "public",
        },
      ],
    });
  return { query, db: { query } as unknown as PgQueryable };
}

describe("Saved List valuation runtime", () => {
  it("authorizes owner reads without exposing cross-account existence", async () => {
    const own = dbWithRows({});
    const ownRuntime = createSavedListValuationRuntime(own.db, { clock: () => "2026-07-13T12:00:00.000Z" });
    await expect(ownRuntime.getOwnerValuation({ listId, ownerAccountId })).resolves.toMatchObject({
      summary: { estimatedTotalAmount: "10.00" },
    });

    const other = dbWithRows({});
    const otherRuntime = createSavedListValuationRuntime(other.db);
    await expect(
      otherRuntime.getOwnerValuation({ listId, ownerAccountId: "acc_other" as AccountId }),
    ).resolves.toBeNull();
  });

  it("does not query or return valuation when shared quantities are hidden", async () => {
    const query = vi.fn();
    const runtime = createSavedListValuationRuntime({ query } as unknown as PgQueryable);
    await expect(
      runtime.getViewerValuation({ listId, disclosure: { showTrackedQuantities: false } }),
    ).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns public-approved value only for an active shared list", async () => {
    const shared = dbWithRows({ visibility: "unlisted" });
    const runtime = createSavedListValuationRuntime(shared.db, { clock: () => "2026-07-13T12:00:00.000Z" });
    await expect(
      runtime.getViewerValuation({ listId, disclosure: { showTrackedQuantities: true } }),
    ).resolves.toMatchObject({ summary: { estimatedTotalAmount: "10.00" } });

    const archived = dbWithRows({ visibility: "public", lifecycle: "archived" });
    await expect(
      createSavedListValuationRuntime(archived.db).getViewerValuation({
        listId,
        disclosure: { showTrackedQuantities: true },
      }),
    ).resolves.toBeNull();
  });
});
