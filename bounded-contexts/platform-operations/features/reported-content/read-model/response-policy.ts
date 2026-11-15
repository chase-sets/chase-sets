export type ReportedContentSeverity = "critical" | "high" | "standard";
export const severityRank = { critical: 0, high: 1, standard: 2 } as const;
export type ReportedContentResponsePolicy = Readonly<{
  revision: string;
  effectiveAt: string;
  timeZone: string;
  openHour: number;
  closeHour: number;
  businessDayRule: string;
  primaryRole: string;
  backupRole: string;
  backupAuthority: string;
  escalationChannelSetting: string;
  targets: Readonly<Record<ReportedContentSeverity, readonly [number, number]>>;
}>;

// Revisions remain in code so a rebuild uses the policy effective at the report's start.
export const REPORTED_CONTENT_RESPONSE_POLICY: readonly ReportedContentResponsePolicy[] = [
  {
    revision: "reported-content-response/2026-11-14",
    effectiveAt: "1970-01-01T00:00:00.000Z",
    timeZone: "America/Chicago",
    openHour: 9,
    closeHour: 17,
    businessDayRule: "weekdays-excluding-observed-us-federal-holidays",
    primaryRole: "Founder",
    backupRole: "Host agent",
    backupAuthority: "triage-and-page-only",
    escalationChannelSetting: "REPORTED_CONTENT_CRITICAL_ESCALATION_CHANNEL",
    targets: { critical: [1, 4], high: [4, 1], standard: [1, 3] },
  },
] as const;

export const REPORTED_CONTENT_REASON_POLICY: Readonly<
  Record<string, Readonly<{ category: string; severity: ReportedContentSeverity }>>
> = {
  "counterfeit-concern": { category: "counterfeit-ip-stolen-photo", severity: "standard" },
  "stolen-photos": { category: "counterfeit-ip-stolen-photo", severity: "standard" },
  "prohibited-item": { category: "prohibited-goods", severity: "standard" },
  "pricing-scam": { category: "spam-manipulation", severity: "standard" },
  "spam-or-manipulation": { category: "spam-manipulation", severity: "standard" },
  "harassment-or-abuse": { category: "harassment-hate-threats", severity: "high" },
  "hate-or-discrimination": { category: "harassment-hate-threats", severity: "high" },
  "sexual-exploitation": { category: "sexual-exploitation", severity: "critical" },
  "personal-information": { category: "exposed-personal-information", severity: "critical" },
  "impersonation-or-deception": { category: "impersonation-deception", severity: "high" },
  other: { category: "other", severity: "standard" },
};

export function reportedContentReason(reason: string) {
  return Object.hasOwn(REPORTED_CONTENT_REASON_POLICY, reason)
    ? REPORTED_CONTENT_REASON_POLICY[reason]!
    : { category: "policy-incomplete", severity: "critical" as const };
}

export function reportedContentSeverity(reasons: readonly string[], priorDispositions = 0) {
  return reasons.reduce<ReportedContentSeverity>(
    (severity, reason) => {
      const next = reportedContentReason(reason).severity;
      return severityRank[next] < severityRank[severity] ? next : severity;
    },
    priorDispositions >= 2 ? "high" : "standard",
  );
}

const calendar = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function localParts(instant: number) {
  const parts = Object.fromEntries(calendar.formatToParts(instant).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}
function localInstant(date: Date, hour: number, minute = 0, second = 0, millis = 0) {
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, second, millis);
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(instant);
    instant += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, millis);
  }
  const resolved = localParts(instant);
  if (
    resolved.year !== date.getUTCFullYear() ||
    resolved.month !== date.getUTCMonth() + 1 ||
    resolved.day !== date.getUTCDate() ||
    resolved.hour !== hour ||
    resolved.minute !== minute ||
    resolved.second !== second
  )
    throw new Error("policy-incomplete");
  return instant;
}
function localDate(instant: number) {
  const p = localParts(instant);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}
function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(Date.UTC(year, month, 1));
  return Date.UTC(year, month, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (nth - 1) * 7);
}
function observed(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}
export function isReportedContentBusinessDay(date: Date) {
  if ([0, 6].includes(date.getUTCDay())) return false;
  const y = date.getUTCFullYear();
  const memorial = new Date(Date.UTC(y, 5, 0));
  memorial.setUTCDate(memorial.getUTCDate() - ((memorial.getUTCDay() + 6) % 7));
  return !new Set([
    observed(y, 0, 1),
    observed(y + 1, 0, 1),
    nthWeekday(y, 0, 1, 3),
    nthWeekday(y, 1, 1, 3),
    memorial.getTime(),
    observed(y, 5, 19),
    observed(y, 6, 4),
    nthWeekday(y, 8, 1, 1),
    nthWeekday(y, 9, 1, 2),
    observed(y, 10, 11),
    nthWeekday(y, 10, 4, 4),
    observed(y, 11, 25),
  ]).has(date.getTime());
}
function staffedHours(start: number, hours: number) {
  let cursor = start;
  let remaining = hours * 3_600_000;
  for (let days = 0; days < 370; days++) {
    const date = localDate(cursor);
    if (isReportedContentBusinessDay(date)) {
      const open = localInstant(date, 9);
      const close = localInstant(date, 17);
      cursor = Math.max(cursor, open);
      if (cursor < close) {
        const available = close - cursor;
        if (remaining <= available) return cursor + remaining;
        remaining -= available;
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);
    cursor = localInstant(date, 9);
  }
  throw new Error("policy-incomplete");
}

export function reportedContentDueTimes(
  start: string,
  severity: ReportedContentSeverity,
  revisions: readonly ReportedContentResponsePolicy[] = REPORTED_CONTENT_RESPONSE_POLICY,
) {
  try {
    const instant = Date.parse(start);
    const policy = [...revisions].reverse().find((revision) => Date.parse(revision.effectiveAt) <= instant);
    if (
      !policy?.revision?.trim() ||
      policy.timeZone !== "America/Chicago" ||
      policy.openHour !== 9 ||
      policy.closeHour !== 17 ||
      !policy.primaryRole?.trim() ||
      !policy.backupRole?.trim() ||
      policy.backupAuthority !== "triage-and-page-only" ||
      !policy.escalationChannelSetting?.trim() ||
      !policy.targets?.[severity] ||
      policy.businessDayRule !== "weekdays-excluding-observed-us-federal-holidays"
    )
      throw new Error("policy-incomplete");
    for (const tier of ["critical", "high", "standard"] as const) {
      const pair = policy.targets[tier];
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((target) => Number.isFinite(target) && target > 0))
        throw new Error("policy-incomplete");
    }
    const [ack, disposition] = policy.targets[severity];
    let dispositionAt: number;
    if (severity === "high") {
      const date = localDate(instant);
      date.setUTCDate(date.getUTCDate() + disposition);
      const p = localParts(instant);
      dispositionAt = localInstant(date, p.hour, p.minute, p.second, instant % 1000);
    } else dispositionAt = staffedHours(instant, severity === "standard" ? disposition * 8 : disposition);
    return {
      policy_revision: policy.revision,
      severity,
      policy_code: null,
      acknowledge_due_at: new Date(staffedHours(instant, severity === "standard" ? ack * 8 : ack)).toISOString(),
      disposition_due_at: new Date(dispositionAt).toISOString(),
      accountable_role: policy.primaryRole,
    };
  } catch {
    return {
      policy_revision: null,
      severity: "critical" as const,
      policy_code: "policy-incomplete" as const,
      acknowledge_due_at: null,
      disposition_due_at: null,
      accountable_role: "Founder",
    };
  }
}
