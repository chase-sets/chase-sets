import { useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { CatalogBulkActionProgress } from "../../../../../support/shell-support/api/client";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { shouldAcceptSourceObservationJobProgress } from "../../job-progress";

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

// How often a running import is re-fetched. Job progress is NOT patch-streamable
// on the source-observations realtime topic (durable job lifecycle/progress does
// not emit projection patches), so this is the issue's bounded fallback: a plain
// loader revalidation on an interval, alive only while work is actually running.
const DEFAULT_LIVE_IMPORT_POLL_MS = 4_000;

export type LiveImportJobsState = Readonly<{
  // True while at least one job is active AND the tab is visible — i.e. the
  // interval is actively re-fetching. Drives the "live" affordance in the module.
  live: boolean;
  // Per-job (jobId -> progress) view of completed/total/percent that is guaranteed
  // monotonic: a regressing or out-of-order server snapshot is ignored so the row
  // never visibly counts backward.
  jobProgress: ReadonlyMap<string, ImportJobProgress>;
}>;

export type ImportJobProgress = Readonly<{
  completed: number;
  total: number;
  progressPercent: number;
}>;

type LiveImportJobsOptions = Readonly<{
  pollMs?: number;
}>;

// The reducer reasons over the progress contract; the percent is a read-model-only
// display value, so it is cached next to (not inside) the accepted snapshot.
type AcceptedJobProgress = Readonly<{
  progress: CatalogBulkActionProgress;
  progressPercent: number;
}>;

// Map a read-model job row onto the CatalogBulkActionProgress shape the monotonic
// reducer reasons over: the durable job `state` is the progress `phase`, and the
// completed/total counters carry across unchanged. `progressPercent` is a read-
// model-only display value (not part of the progress contract), so it rides
// alongside the accepted snapshot rather than inside it.
function jobToProgress(job: ImportJobRow): CatalogBulkActionProgress {
  return {
    phase: job.state,
    completed: job.completed,
    total: job.total,
    currentName: null,
    status: job.operatorStatus,
  };
}

// Live import-job progress for the daily workbench. Revalidates the route loader
// on a bounded interval — only while a job is active and the tab is visible — and
// gates every refreshed snapshot through the monotonic reducer so out-of-order /
// regressing server reads never render backward. Loader revalidation refreshes the
// read model in place (no remount), so the operator's open stage and selection
// survive a live refresh.
export function useLiveImportJobs(
  readModel: CatalogPrimaryWorkbenchReadModel,
  options: LiveImportJobsOptions = {},
): LiveImportJobsState {
  const pollMs = options.pollMs ?? DEFAULT_LIVE_IMPORT_POLL_MS;
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;

  const jobs = readModel.importJobs.jobs;
  const hasActiveJobs = readModel.importJobs.activeJobCount > 0;

  // Last accepted progress per job (the contract snapshot the reducer compares,
  // plus the read-model-only percent that rides with it), kept across renders so
  // monotonic gating is stable even though every revalidation hands us a fresh
  // read-model identity. Writing this cache during render (rather than in an
  // effect) keeps the gated map a pure derivation of the latest jobs and avoids an
  // extra commit/render per refresh — no state thrash, no reload loop.
  const acceptedRef = useRef<Map<string, AcceptedJobProgress>>(new Map());
  const jobProgress = useMemo<ReadonlyMap<string, ImportJobProgress>>(() => {
    const accepted = new Map<string, AcceptedJobProgress>();
    const next = new Map<string, ImportJobProgress>();

    for (const job of jobs) {
      const incoming = jobToProgress(job);
      const previous = acceptedRef.current.get(job.jobId) ?? null;
      const resolved = shouldAcceptSourceObservationJobProgress(previous?.progress ?? null, incoming)
        ? { progress: incoming, progressPercent: job.progressPercent }
        : (previous ?? { progress: incoming, progressPercent: job.progressPercent });

      accepted.set(job.jobId, resolved);
      next.set(job.jobId, {
        completed: resolved.progress.completed,
        total: resolved.progress.total,
        progressPercent: resolved.progressPercent,
      });
    }

    // Drop jobs that left the table so the cache never grows unbounded.
    acceptedRef.current = accepted;
    return next;
  }, [jobs]);

  // Pause when the tab is hidden: a backgrounded workbench should not keep
  // re-fetching. Track visibility as state so `live` recomputes on change.
  const [documentVisible, setDocumentVisible] = useState(() => !isDocumentHidden());
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const onVisibilityChange = () => {
      setDocumentVisible(!isDocumentHidden());
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const live = hasActiveJobs && documentVisible;

  // The bounded poll: arm a timer only while jobs are active and the tab is
  // visible; tear it down on terminal state, when the tab hides, and on unmount.
  // The effect depends only on the primitives `live`/`pollMs`, so unrelated
  // re-renders (e.g. a revalidated read model) never re-arm the interval.
  useEffect(() => {
    if (!live) {
      return;
    }

    const interval = setInterval(() => {
      revalidateRef.current();
    }, pollMs);

    return () => {
      clearInterval(interval);
    };
  }, [live, pollMs]);

  return { live, jobProgress };
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
