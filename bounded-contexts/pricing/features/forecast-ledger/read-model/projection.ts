import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
} from "../../repricing-engine/domain/fact";
import { pricedLedgerEntries } from "../domain/ledger";
import { insertForecastLedgerEntries } from "./queries";

/**
 * Projects each evaluation's incumbent and shadow prices into the Forecast
 * Ledger with the forecasts the evaluation recorded, so emission and shadow
 * paths need no write of their own and a late or replayed projection records
 * the same forecasts. Entries are written once; a redelivered evaluation
 * leaves its entries unchanged.
 */
export function buildForecastLedgerProjectionHandlers(pool: PgQueryable): ProjectorHandlerMap {
  return {
    [repricingPolicyEvaluatedEventType]: async (event, context) => {
      const entries = pricedLedgerEntries(event.data as RepricingPolicyEvaluatedEvent["data"]);
      await insertForecastLedgerEntries(
        (context?.db as PgQueryable | undefined) ?? pool,
        entries,
        event.globalPosition,
      );
    },
  };
}
