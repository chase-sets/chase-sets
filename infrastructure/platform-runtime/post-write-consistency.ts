export type PlatformPostWriteConsistencyOutcome =
  | "missing_strategy"
  | "optimistic_applied"
  | "freshness_timeout"
  | "rollback"
  | "reconciliation"
  | "stale_response_discard"
  | "handoff_parsed"
  | "handoff_satisfied"
  | "handoff_pending"
  | "handoff_expired"
  | "handoff_invalid"
  | "handoff_malformed"
  | "handoff_permanent";

export type PlatformPostWriteConsistencyEvent = Readonly<{
  boundedContextName: string;
  surface: string;
  strategy: string;
  outcome: PlatformPostWriteConsistencyOutcome;
  routeId?: string | null;
  routeTemplate?: string | null;
  correctionSource?: string | null;
  actorMode?: string | null;
  recoveryAction?: string | null;
  freshnessOutcome?: string | null;
}>;

export type PlatformPostWriteConsistencyRecorder = (event: PlatformPostWriteConsistencyEvent) => void;

let postWriteConsistencyRecorder: PlatformPostWriteConsistencyRecorder | null = null;
const pendingPostWriteConsistencyEvents: PlatformPostWriteConsistencyEvent[] = [];
const maxPendingPostWriteConsistencyEvents = 100;

export function registerPostWriteConsistencyRecorder(recorder: PlatformPostWriteConsistencyRecorder | null) {
  const previous = postWriteConsistencyRecorder;
  postWriteConsistencyRecorder = recorder;

  if (recorder) {
    for (const event of pendingPostWriteConsistencyEvents.splice(0)) {
      recorder(event);
    }
  }

  return () => {
    if (postWriteConsistencyRecorder === recorder) {
      postWriteConsistencyRecorder = previous;
    }
  };
}

export function recordPlatformPostWriteConsistencyEvent(event: PlatformPostWriteConsistencyEvent) {
  if (postWriteConsistencyRecorder) {
    postWriteConsistencyRecorder(event);
    return;
  }

  if (pendingPostWriteConsistencyEvents.length >= maxPendingPostWriteConsistencyEvents) {
    pendingPostWriteConsistencyEvents.shift();
  }
  pendingPostWriteConsistencyEvents.push(event);
}
