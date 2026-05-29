import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SavePromoBarMessageRequest } from "./contracts";
import {
  createPromoBarMessage,
  deletePromoBarMessage,
  listActivePromoBarMessages,
  listPromoBarMessages,
  setPromoBarMessageActive,
  updatePromoBarMessage,
} from "../read-model/queries";

export type PromoBarServices = Readonly<{
  listActivePromoBarMessages: () => ReturnType<typeof listActivePromoBarMessages>;
  listPromoBarMessages: () => ReturnType<typeof listPromoBarMessages>;
  createPromoBarMessage: (input: SavePromoBarMessageRequest) => ReturnType<typeof createPromoBarMessage>;
  updatePromoBarMessage: (id: string, input: SavePromoBarMessageRequest) => ReturnType<typeof updatePromoBarMessage>;
  setPromoBarMessageActive: (id: string, isActive: boolean) => ReturnType<typeof setPromoBarMessageActive>;
  deletePromoBarMessage: (id: string) => ReturnType<typeof deletePromoBarMessage>;
}>;

export function createPromoBarRuntime(db: PgQueryable): PromoBarServices {
  return {
    listActivePromoBarMessages: () => listActivePromoBarMessages(db),
    listPromoBarMessages: () => listPromoBarMessages(db),
    createPromoBarMessage: (input) => createPromoBarMessage(db, input),
    updatePromoBarMessage: (id, input) => updatePromoBarMessage(db, id, input),
    setPromoBarMessageActive: (id, isActive) => setPromoBarMessageActive(db, id, isActive),
    deletePromoBarMessage: (id) => deletePromoBarMessage(db, id),
  };
}
