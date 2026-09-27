import type { SavedListAdditionResponse, SavedListDiscoverySurface } from "./discovery-contracts";
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

function event(name: EventName, labels: Partial<Record<LabelKey, unknown>>): SavedListAnalyticsEvent {
  const label = <K extends LabelKey>(key: K): LabelValue<K> =>
    (savedListAnalyticsKeys[name] as readonly string[]).includes(key) ? analyticsLabel(key, labels[key]) : "none";
  return {
    event: name,
    surface: label("surface"),
    outcome: label("outcome"),
    coverage_band: label("coverage_band"),
    estimate_state: label("estimate_state"),
  };
}

export function additionAnalytics(
  response: SavedListAdditionResponse,
  surface: SavedListDiscoverySurface,
): SavedListAnalyticsEvent[] {
  const { receipt, savedList } = response.command;
  if (receipt.replayed) return [];
  const events: SavedListAnalyticsEvent[] = [];
  if (receipt.outcome === "created") events.push(event("list_created", { surface }));
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
