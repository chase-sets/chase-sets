import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
} from "../../repricing-engine/domain/fact";
import type { ForecastKindDefinition } from "../domain/forecast-kinds";
import { pricedLedgerEntries, toForecastLedgerEntries } from "../domain/ledger";
import { insertForecastLedgerEntries, loadForecastCurves } from "./queries";

/**
 * Projects each evaluation's incumbent and shadow prices into the Forecast
 * Ledger with every registered forecast, so emission and shadow paths need no
 * write of their own. Entries are written once; a redelivered evaluation
 * leaves its entries unchanged.
 */
export function buildForecastLedgerProjectionHandlers(
  pool: PgTransactionalPool,
  kinds: () => readonly ForecastKindDefinition[],
): ProjectorHandlerMap {
  return {
    [repricingPolicyEvaluatedEventType]: async (event, context) => {
      const data = event.data as RepricingPolicyEvaluatedEvent["data"];
      const priced = pricedLedgerEntries(data);
      if (priced.length === 0) return;
      const project = async (db: PgQueryable) => {
        const curves = await loadForecastCurves(db, {
          catalogItemId: data.catalogItemId,
          productId: data.productId,
          versions: [...new Set(priced.flatMap((entry) => entry.curveVersion ?? []))],
          pricedAt: data.evaluatedAt,
        });
        const entries = toForecastLedgerEntries(priced, (version) => curves.get(version) ?? null, kinds());
        await insertForecastLedgerEntries(db, entries, event.globalPosition);
      };
      if (context?.db) {
        await project(context.db as PgQueryable);
      } else {
        await withPgTransaction(pool, project);
      }
    },
  };
}
