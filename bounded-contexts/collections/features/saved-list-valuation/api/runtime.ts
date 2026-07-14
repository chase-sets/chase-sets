import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListId } from "../../saved-lists/domain";
import { type SavedListValuationSnapshot, type SavedListValuationViewerDisclosure } from "../domain/contracts";
import { calculateSavedListValuation } from "../domain/valuation";
import { getSavedListValuationSource } from "../read-model/queries";

export type SavedListValuationServices = Readonly<{
  getOwnerValuation: (
    input: Readonly<{ listId: SavedListId; ownerAccountId: AccountId }>,
  ) => Promise<SavedListValuationSnapshot | null>;
  getViewerValuation: (
    input: Readonly<{ listId: SavedListId; disclosure: SavedListValuationViewerDisclosure }>,
  ) => Promise<SavedListValuationSnapshot | null>;
}>;

export function createSavedListValuationRuntime(
  db: PgQueryable,
  options: Readonly<{ clock?: () => string; currencyCode?: string }> = {},
): SavedListValuationServices {
  const now = options.clock ?? (() => new Date().toISOString());
  const currencyCode = options.currencyCode ?? "usd";

  return {
    getOwnerValuation: async ({ listId, ownerAccountId }) => {
      const source = await getSavedListValuationSource(db, listId);
      if (!source || source.ownerAccountId !== ownerAccountId) {
        return null;
      }
      const valuation = calculateSavedListValuation({
        lines: source.lines,
        estimates: source.estimates,
        audience: "account",
        currencyCode,
        valuedAt: now(),
      });
      return {
        contractVersion: 1,
        listId: source.listId,
        visibility: source.visibility,
        ...valuation,
      };
    },
    getViewerValuation: async ({ listId, disclosure }) => {
      if (!disclosure.showTrackedQuantities) {
        return null;
      }
      const source = await getSavedListValuationSource(db, listId);
      if (!source || source.lifecycle !== "active" || source.visibility === "private") {
        return null;
      }
      const valuation = calculateSavedListValuation({
        lines: source.lines,
        estimates: source.estimates,
        audience: "public",
        currencyCode,
        valuedAt: now(),
      });
      return {
        contractVersion: 1,
        listId: source.listId,
        visibility: source.visibility,
        ...valuation,
      };
    },
  };
}
