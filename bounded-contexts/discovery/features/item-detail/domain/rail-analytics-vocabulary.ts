export const itemDetailRailAnalyticsEventNames = [
  "rail_intent_selected",
  "workflow_selected",
  "similar_item_selected",
  "search_result_selected",
  "reference_info_opened",
  "payout_preview_shown",
  "standard_preview_unavailable",
  "registration_gate_shown",
  "registration_started",
  "registration_return_completed",
  "term_delta_reviewed",
  "intent_persisted",
  "commit_gate_reached",
  "intent_submit_started",
  "validation_failed",
] as const;

export const itemDetailRailAnalyticsLabelNames = [
  "intent",
  "workflow",
  "selection",
  "topic",
  "outcome",
  "gate",
  "viewer",
  "surface",
] as const;

export type ItemDetailRailAnalyticsEventName = (typeof itemDetailRailAnalyticsEventNames)[number];
export type ItemDetailRailAnalyticsLabelName = (typeof itemDetailRailAnalyticsLabelNames)[number];
