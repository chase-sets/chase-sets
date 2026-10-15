import type { DomainEvent } from "@chase-sets/event-core";
import type { ForecastGrade } from "./grading";
import type { ForecastLedgerRole } from "./ledger";

export const forecastGradedEventType = "pricing.forecast.graded" as const;

/** A Forecast Grade for one goal version, role, Forecast Kind, model, and horizon over the cohort closed on a day. */
export type ForecastGradedEvent = DomainEvent<
  typeof forecastGradedEventType,
  Readonly<{
    schemaVersion: 1;
    goalId: string;
    goalVersion: number;
    role: ForecastLedgerRole;
    forecastKind: string;
    model: string;
    horizonDays: number;
    /** The cohort closed at the start of this UTC day. */
    closedOn: string;
    /** Identifies the grace, horizons, and grading implementation the grade followed. */
    rulesVersion: string;
    /** Identifies the ledger and realized-sale inputs graded; a regrade of the same day carries a new one. */
    inputVersion: string;
    grade: ForecastGrade;
    gradedAt: string;
  }>
>;
