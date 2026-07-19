import { toTransportEvent, type StoredEvent } from "@chase-sets/event-core";
import { runInProjectionDbContext, withProjectionTransaction } from "./projection-transactions";
import { claimInlineSubscriptionApplication, recordSubscriptionApplicationCompleted } from "./subscription-store";
import type { ContextProjectionGroup } from "./projection-groups";
import type { ContextSubscriptionRunner } from "./subscriptions";

export const PROJECTION_INLINE_APPLY_ENABLED_ENV = "PROJECTION_INLINE_APPLY_ENABLED";
export const DEFAULT_PROJECTION_INLINE_APPLY_BUDGET_MS = 100;
const INLINE_CLAIM_LOCK_TIMEOUT_MS = 1;

export type ProjectionInlineApplyOutcome = "applied" | "deferred" | "failed";
export type ProjectionInlineApplyReason =
  | "applied"
  | "already-applied"
  | "blocked-stream"
  | "predecessor-gap"
  | "in-flight"
  | "budget-exceeded"
  | "handler-failed";

export type ProjectionInlineApplyOutcomeSignal = Readonly<{
  outcome: ProjectionInlineApplyOutcome;
  reason: ProjectionInlineApplyReason;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  subscriptionName: string;
  durationMs: number;
}>;

export type ProjectionInlineApplySummary = Readonly<{
  applied: number;
  deferred: number;
  failed: number;
}>;

export type ApplyCommittedProjectionEventsInlineInput = Readonly<{
  committedEvents: readonly StoredEvent[];
  commitSources: readonly Readonly<{ sourceContextName: string; eventIds: readonly string[] }>[];
  projectionGroups: readonly ContextProjectionGroup[];
  budgetMs?: number;
  recordOutcome?: (signal: ProjectionInlineApplyOutcomeSignal) => void;
}>;

type InlineCandidate = Readonly<{
  group: ContextProjectionGroup;
  runner: ContextSubscriptionRunner;
  event: StoredEvent;
}>;

type AttemptResult = Readonly<{
  outcome: ProjectionInlineApplyOutcome;
  reason: ProjectionInlineApplyReason;
}>;

class InlineApplyBudgetExceededError extends Error {
  constructor() {
    super("Projection inline apply exceeded its request budget.");
    this.name = "InlineApplyBudgetExceededError";
  }
}

export function projectionInlineApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROJECTION_INLINE_APPLY_ENABLED_ENV]?.trim().toLowerCase() === "true";
}

export async function applyCommittedProjectionEventsInline(
  input: ApplyCommittedProjectionEventsInlineInput,
): Promise<ProjectionInlineApplySummary> {
  const candidates = collectInlineCandidates(input);
  const summary = { applied: 0, deferred: 0, failed: 0 };
  if (candidates.length === 0) {
    return summary;
  }

  const budgetMs = normalizeBudgetMs(input.budgetMs);
  const deadlineMs = Date.now() + budgetMs;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      for (const deferred of candidates.slice(index)) {
        recordAttempt(input.recordOutcome, deferred, summary, {
          outcome: "deferred",
          reason: "budget-exceeded",
        });
      }
      break;
    }

    const startedAtMs = Date.now();
    const result = await attemptWithinBudget(candidate, deadlineMs, remainingMs);
    recordAttempt(input.recordOutcome, candidate, summary, result, Date.now() - startedAtMs);
    if (result.reason === "budget-exceeded") {
      for (const deferred of candidates.slice(index + 1)) {
        recordAttempt(input.recordOutcome, deferred, summary, {
          outcome: "deferred",
          reason: "budget-exceeded",
        });
      }
      break;
    }
  }

  return summary;
}

function collectInlineCandidates(input: ApplyCommittedProjectionEventsInlineInput): readonly InlineCandidate[] {
  const sourceByEventId = new Map<string, string>();
  for (const source of input.commitSources) {
    for (const eventId of source.eventIds) {
      sourceByEventId.set(eventId, source.sourceContextName);
    }
  }

  const candidates: InlineCandidate[] = [];
  for (const group of input.projectionGroups) {
    const runner = group.subscriptionRunners.find((entry) => entry.inlineApply === true);
    if (!runner || !runner.handlers || !group.targetPool) {
      continue;
    }

    for (const event of input.committedEvents) {
      if (sourceByEventId.get(String(event.eventId)) !== runner.sourceContextName) {
        continue;
      }
      if (runner.eventTypes && !runner.eventTypes.includes(event.eventType)) {
        continue;
      }
      if (runner.streamPrefixes && !runner.streamPrefixes.some((prefix) => event.streamId.startsWith(prefix))) {
        continue;
      }
      if (!runner.handlers[event.eventType]) {
        continue;
      }

      candidates.push({ group, runner, event });
    }
  }

  return candidates;
}

async function attemptWithinBudget(
  candidate: InlineCandidate,
  deadlineMs: number,
  remainingMs: number,
): Promise<AttemptResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = applyCandidate(candidate, deadlineMs, remainingMs).catch((error: unknown) =>
    classifyAttemptError(error),
  );
  const timeout = new Promise<AttemptResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "failed", reason: "budget-exceeded" }), Math.max(1, remainingMs));
  });

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // `attempt` owns its rejection and transaction rollback even if the request
    // budget wins the race while a JavaScript-only handler is still running.
    void attempt;
  }
}

async function applyCandidate(
  candidate: InlineCandidate,
  deadlineMs: number,
  remainingMs: number,
): Promise<AttemptResult> {
  const { group, runner } = candidate;
  const event = toTransportEvent(candidate.event);
  const handler = runner.handlers?.[event.type];
  if (!group.targetPool || !handler) {
    return { outcome: "deferred", reason: "in-flight" };
  }

  const throwIfBudgetExceeded = () => {
    if (Date.now() >= deadlineMs) {
      throw new InlineApplyBudgetExceededError();
    }
  };
  const transactionTimeoutMs = Math.max(1, Math.min(remainingMs, runner.projectionTransactionTimeoutMs ?? remainingMs));
  const statementTimeoutMs = Math.max(
    1,
    Math.min(transactionTimeoutMs, runner.projectionStatementTimeoutMs ?? transactionTimeoutMs),
  );

  return withProjectionTransaction(
    group.targetPool,
    {
      transactionTimeoutMs,
      statementTimeoutMs,
      throwIfLeaseLost: throwIfBudgetExceeded,
    },
    async (client) => {
      const claim = await claimInlineSubscriptionApplication(
        client,
        runner.checkpointKey,
        event,
        INLINE_CLAIM_LOCK_TIMEOUT_MS,
      );
      if (claim !== "claimed") {
        return {
          outcome: "deferred",
          reason: claim,
        } satisfies AttemptResult;
      }

      await runInProjectionDbContext(client, () =>
        handler(event, { db: client, throwIfLeaseLost: throwIfBudgetExceeded }),
      );
      throwIfBudgetExceeded();
      await recordSubscriptionApplicationCompleted(client, runner.checkpointKey, String(event.id), "applied");
      return { outcome: "applied", reason: "applied" } satisfies AttemptResult;
    },
    {
      handlerKind: "projection-inline",
      targetContextName: group.targetContextName,
      sourceContextName: runner.sourceContextName,
      projectionName: group.projectionName,
      subscriptionName: runner.subscriptionName,
    },
  );
}

function classifyAttemptError(error: unknown): AttemptResult {
  if (error instanceof InlineApplyBudgetExceededError || postgresErrorCode(error) === "57014") {
    return { outcome: "failed", reason: "budget-exceeded" };
  }
  if (postgresErrorCode(error) === "55P03") {
    return { outcome: "deferred", reason: "in-flight" };
  }
  return { outcome: "failed", reason: "handler-failed" };
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as Readonly<{ code?: unknown }>).code ?? "")
    : undefined;
}

function recordAttempt(
  observer: ApplyCommittedProjectionEventsInlineInput["recordOutcome"],
  candidate: InlineCandidate,
  summary: { applied: number; deferred: number; failed: number },
  result: AttemptResult,
  durationMs = 0,
): void {
  summary[result.outcome] += 1;
  try {
    observer?.({
      ...result,
      sourceContextName: candidate.runner.sourceContextName,
      targetContextName: candidate.group.targetContextName,
      projectionName: candidate.group.projectionName,
      subscriptionName: candidate.runner.subscriptionName,
      durationMs: Math.max(0, durationMs),
    });
  } catch {
    // Telemetry can never affect command success or projection fallback.
  }
}

function normalizeBudgetMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PROJECTION_INLINE_APPLY_BUDGET_MS;
  }
  return Math.max(1, Math.floor(value));
}
