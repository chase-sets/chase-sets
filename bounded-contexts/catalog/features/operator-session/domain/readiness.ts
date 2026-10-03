export type OperatorSessionIdentity = Readonly<{
  source: "operator-session" | "environment";
  revision: number;
  custodyRevision: number;
}>;

export type OperatorSessionOutcome = OperatorSessionIdentity &
  Readonly<{
    state: "untested" | "healthy" | "rejecting";
    stateSince: string;
    lastRejectionAt: string | null;
    lastRejectionStatus: 401 | 403 | null;
    rateBudgetContext: "retained" | "unknown";
    everSucceeded: boolean;
    updatedAt: string;
  }>;

export type OperatorSessionReadinessSnapshot = Readonly<{
  custody: "absent" | "cleared" | "stored" | "unavailable";
  identity: OperatorSessionIdentity | null;
  browserExpiresAt: string | null;
  outcome: OperatorSessionOutcome | null;
}>;

export type OperatorSessionOutcomeRow = {
  source: "operator-session" | "environment";
  revision: string;
  custody_revision: string;
  state: "untested" | "healthy" | "rejecting";
  state_since: Date | string;
  last_rejection_at: Date | string | null;
  last_rejection_status: 401 | 403 | null;
  rate_budget_context: "retained" | "unknown";
  ever_succeeded: boolean;
  updated_at: Date | string;
};

export function operatorSessionOutcomeFromRow(row: OperatorSessionOutcomeRow): OperatorSessionOutcome {
  return {
    source: row.source,
    revision: Number(row.revision),
    custodyRevision: Number(row.custody_revision),
    state: row.state,
    stateSince: new Date(row.state_since).toISOString(),
    lastRejectionAt: row.last_rejection_at === null ? null : new Date(row.last_rejection_at).toISOString(),
    lastRejectionStatus: row.last_rejection_status,
    rateBudgetContext: row.rate_budget_context,
    everSucceeded: row.ever_succeeded,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export const operatorSessionRejectionWindowMs = 30 * 60 * 1000;
export const operatorSessionRefreshIntervalMs = 5 * 60 * 1000;

export function sameOperatorSessionIdentity(a: OperatorSessionIdentity, b: OperatorSessionIdentity): boolean {
  return a.source === b.source && a.revision === b.revision && a.custodyRevision === b.custodyRevision;
}

export function validOperatorSessionIdentity(identity: OperatorSessionIdentity): boolean {
  return (
    Number.isSafeInteger(identity.revision) &&
    identity.revision >= 0 &&
    Number.isSafeInteger(identity.custodyRevision) &&
    identity.custodyRevision >= 0 &&
    (identity.source === "environment"
      ? identity.revision === 0
      : identity.source === "operator-session" &&
        identity.revision > 0 &&
        identity.revision === identity.custodyRevision)
  );
}

export function deriveTcgplayerOperatorSessionReadiness(snapshot: OperatorSessionReadinessSnapshot, now: number) {
  const sourceKind =
    snapshot.custody === "stored" || snapshot.custody === "unavailable"
      ? ("operator-session" as const)
      : ("environment-secret" as const);
  const result = (
    state: "configured" | "missing" | "unknown" | "expired" | "invalid",
    diagnosticCode: string | null,
  ) => ({ sourceKind, state, diagnosticCode });
  if (snapshot.custody === "unavailable") return result("unknown", "operator-session-custody-unavailable");
  if (!snapshot.identity) return result("missing", "credential-missing");
  if (
    snapshot.custody === "stored" &&
    snapshot.browserExpiresAt !== null &&
    Date.parse(snapshot.browserExpiresAt) <= now
  )
    return result("expired", "operator-session-expired");
  const outcome = snapshot.outcome;
  if (!outcome || !sameOperatorSessionIdentity(snapshot.identity, outcome) || outcome.state !== "rejecting")
    return result("configured", null);
  if (outcome.lastRejectionStatus === 401) return result("invalid", "credential-refresh-needed");
  const last = Date.parse(outcome.lastRejectionAt ?? "");
  if (
    last - Date.parse(outcome.stateSince) < operatorSessionRejectionWindowMs ||
    now - last > operatorSessionRejectionWindowMs ||
    now < last ||
    !Number.isFinite(last)
  )
    return result("configured", null);
  if (outcome.rateBudgetContext !== "retained") return result("unknown", "adapter-authentication-failed");
  if (outcome.source === "operator-session" && !outcome.everSucceeded)
    return result("unknown", "rejected-after-refresh");
  return result("invalid", "credential-refresh-needed");
}

export function nextOperatorSessionOutcome(
  identity: OperatorSessionIdentity,
  previous: OperatorSessionOutcome | null,
  status: number,
  rateBudgetContext: "retained" | "unknown",
  now: string,
): OperatorSessionOutcome | null {
  if (!(status >= 200 && status < 300) && status !== 401 && status !== 403) return null;
  const current = previous && sameOperatorSessionIdentity(identity, previous) ? previous : null;
  if (status >= 200 && status < 300) {
    if (current?.state === "healthy") return null;
    return {
      ...identity,
      state: "healthy",
      stateSince: now,
      lastRejectionAt: null,
      lastRejectionStatus: null,
      rateBudgetContext: "unknown",
      everSucceeded: true,
      updatedAt: now,
    };
  }
  const rejecting = current?.state === "rejecting";
  const gap = rejecting ? Date.parse(now) - Date.parse(current.lastRejectionAt!) : Infinity;
  const rejectionStatus = status === 401 || (rejecting && current.lastRejectionStatus === 401) ? 401 : 403;
  if (
    rejecting &&
    gap < operatorSessionRefreshIntervalMs &&
    current.lastRejectionStatus === rejectionStatus &&
    current.rateBudgetContext === rateBudgetContext
  )
    return null;
  return {
    ...identity,
    state: "rejecting",
    stateSince: rejecting && gap <= operatorSessionRejectionWindowMs ? current.stateSince : now,
    lastRejectionAt: now,
    lastRejectionStatus: rejectionStatus,
    rateBudgetContext,
    everSucceeded: current?.everSucceeded ?? false,
    updatedAt: now,
  };
}
