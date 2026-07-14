import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listDiscoveryRecentSavedLists } from "../read-model/queries";

export type SavedListPickerServices = Readonly<{
  listRecent: (input: Readonly<{ ownerAccountId: string }>) => ReturnType<typeof listDiscoveryRecentSavedLists>;
}>;

/** Composes the Saved List Addition slice's local read side. */
export function createSavedListPickerRuntime(db: PgQueryable): SavedListPickerServices {
  return {
    listRecent: (input) => listDiscoveryRecentSavedLists(db, input),
  };
}
