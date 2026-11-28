import type { SavedListAdditionResponse, SavedListDiscoverySurface } from "./discovery-contracts";
import type { SavedListCommandReceipt } from "../domain/contracts";
import type { SavedListValuationCoverage } from "../../saved-list-valuation/domain/contracts";

export const savedListAnalyticsEvents = Object.freeze([
  "list_created",
  "product_added",
  "first_five_lines",
  "valuation_coverage_band",
] as const);
export const savedListAnalyticsKeys = Object.freeze({
  list_created: Object.freeze(["surface"] as const),
  product_added: Object.freeze(["surface", "outcome"] as const),
  first_five_lines: Object.freeze(["surface"] as const),
  valuation_coverage_band: Object.freeze(["coverage_band", "estimate_state"] as const),
});
export const savedListAnalyticsValues = Object.freeze({
  surface: Object.freeze(["search", "item-detail"] as const),
  outcome: Object.freeze(["added", "merged"] as const),
  coverage_band: Object.freeze(["empty", "none", "low", "partial", "high", "full"] as const),
  estimate_state: Object.freeze(["empty", "incomplete", "stale", "low_confidence", "current"] as const),
});

type EventName = (typeof savedListAnalyticsEvents)[number];
type LabelKey = keyof typeof savedListAnalyticsValues;
type LabelValue<K extends LabelKey> = (typeof savedListAnalyticsValues)[K][number] | "none" | "invalid";
export type SavedListAnalyticsEvent = Readonly<
  {
    event: EventName;
  } & { [K in LabelKey]: LabelValue<K> }
>;
export type SavedListAnalyticsRecorder = Readonly<{
  record: (event: SavedListAnalyticsEvent) => void | Promise<void>;
}>;

export function analyticsLabel<K extends LabelKey>(key: K, value: unknown): LabelValue<K> {
  return (savedListAnalyticsValues[key] as readonly unknown[]).includes(value) ? (value as LabelValue<K>) : "invalid";
}

function eventLabels(name: EventName | undefined, labels: Partial<Record<LabelKey, unknown>>) {
  const keys: readonly LabelKey[] = name === undefined ? [] : savedListAnalyticsKeys[name];
  const label = <K extends LabelKey>(key: K): LabelValue<K> =>
    keys.includes(key) ? analyticsLabel(key, labels[key]) : "none";
  return {
    surface: label("surface"),
    outcome: label("outcome"),
    coverage_band: label("coverage_band"),
    estimate_state: label("estimate_state"),
  };
}

function event(name: EventName, labels: Partial<Record<LabelKey, unknown>>): SavedListAnalyticsEvent {
  return { event: name, ...eventLabels(name, labels) };
}

function savedListAnalyticsAttributes(signal: SavedListAnalyticsEvent) {
  const name = signal.event;
  const knownEvent = savedListAnalyticsEvents.find((allowed) => allowed === name);
  return { context: "collections", event: knownEvent ?? "invalid", ...eventLabels(knownEvent, signal) };
}

type SavedListAnalyticsSinks = Readonly<{
  createCounter: (name: string) => {
    add: (increment: number, attributes: Readonly<ReturnType<typeof savedListAnalyticsAttributes>>) => void;
  };
  logger: Readonly<Record<"info" | "warn", (message: string, fields: Readonly<Record<string, string>>) => void>>;
}>;

export function createSavedListAnalyticsRecorder({
  createCounter,
  logger,
}: SavedListAnalyticsSinks): SavedListAnalyticsRecorder {
  const counter = createCounter("chase_sets_collections_saved_list_events_total");
  return {
    record(signal) {
      let attributes: ReturnType<typeof savedListAnalyticsAttributes>;
      try {
        attributes = savedListAnalyticsAttributes(signal);
      } catch {
        // Invalid event objects are ignored without exposing input or exception text.
        return;
      }
      const fields = { ...attributes, type: "collections.saved_list.analytics_event" };
      try {
        counter.add(1, attributes);
      } catch {
        try {
          logger.warn("Collections Saved List analytics recorder failed.", {
            failure: "counter",
            type: "collections.saved_list.analytics_recorder_failure",
          });
        } catch {
          // Failure reporting is best-effort; still attempt the event log.
        }
      }
      try {
        logger.info("Collections Saved List analytics event captured.", fields);
      } catch {
        // Logging is best-effort and must not affect the Saved List response.
      }
    },
  };
}

export function additionAnalytics(
  response: SavedListAdditionResponse,
  surface: SavedListDiscoverySurface,
  createReceipt?: SavedListCommandReceipt,
): SavedListAnalyticsEvent[] {
  const { receipt, savedList } = response.command;
  if (receipt.replayed) return [];
  const events: SavedListAnalyticsEvent[] = [];
  if (createReceipt?.outcome === "created" && !createReceipt.replayed) {
    events.push(event("list_created", { surface }));
  }
  events.push(event("product_added", { surface, outcome: response.lineStatus }));
  const priorCount =
    savedList.lines.length -
    receipt.lineResults.filter((line) => line.status === "added").length +
    receipt.lineResults.filter((line) => line.status === "removed").length;
  if (savedList.lines.length === 5 && priorCount === 4) {
    events.push(event("first_five_lines", { surface }));
  }
  return events;
}

export function valuationAnalytics(coverage: SavedListValuationCoverage): SavedListAnalyticsEvent {
  const { priced, total, missing, stale, lowConfidence } = coverage;
  const coverage_band =
    total.lines === 0
      ? "empty"
      : priced.lines === 0
        ? "none"
        : priced.lines * 2 < total.lines
          ? "low"
          : priced.lines * 10 < total.lines * 9
            ? "partial"
            : priced.lines < total.lines
              ? "high"
              : "full";
  const estimate_state =
    total.lines === 0
      ? "empty"
      : missing.lines > 0
        ? "incomplete"
        : stale.lines > 0
          ? "stale"
          : lowConfidence.lines > 0
            ? "low_confidence"
            : "current";
  return event("valuation_coverage_band", { coverage_band, estimate_state });
}

export function recordSavedListAnalytics(
  recorder: SavedListAnalyticsRecorder | undefined,
  events: readonly SavedListAnalyticsEvent[],
): void {
  if (!recorder) return;
  for (const item of events) {
    try {
      // The sink is deliberately detached from the HTTP response path.
      void Promise.resolve(recorder.record(item)).catch(() => undefined);
    } catch {
      // Telemetry is best-effort; do not expose sink errors or their messages.
    }
  }
}
