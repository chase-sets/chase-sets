import { classified } from "./backlog-classify.mjs";

export const THROUGHPUT_SERIES = /^(Wave|Mobile)\s+(\d+)\b/;
const NON_EXECUTABLE_MILESTONES = new Set(["Deferred / Incubation", "Operations"]);

export function seriesIdentity(title) {
  if (typeof title !== "string") return null;
  const match = THROUGHPUT_SERIES.exec(title);
  if (!match) return null;
  const ordinal = Number(match[2]);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? { family: match[1], ordinal } : null;
}

export function isRunnableRefined(issue) {
  if (!issue || issue.state !== "open" || !Array.isArray(issue.blockedBy)) return false;
  const openBlockerCount = issue.blockedBy.filter((blocker) => blocker?.state === "open").length;
  return (
    openBlockerCount === 0 &&
    classified({
      number: issue.number,
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      issueTypeName: issue.issueTypeName,
      milestoneTitle: issue.milestone?.title ?? null,
      blockedByCount: openBlockerCount,
      hasParent: false,
    })
  );
}

/**
 * Select one pull milestone per exact Wave/Mobile series. Input is the
 * normalized, complete authority published by roadmap-status; this helper has
 * no provider or mutation operation.
 */
export function derivePullWindow({ milestones, issues }) {
  const candidates = new Map();
  const milestoneById = new Map();
  for (const milestone of milestones) {
    const series = seriesIdentity(milestone?.title);
    if (!series || milestone.state !== "open" || NON_EXECUTABLE_MILESTONES.has(milestone.title)) continue;
    milestoneById.set(milestone.id, { milestone, series });
  }
  for (const issue of issues) {
    const entry = milestoneById.get(issue?.milestone?.id);
    if (!entry || !isRunnableRefined(issue)) continue;
    const key = entry.series.family;
    const current = candidates.get(key);
    if (!current || entry.series.ordinal < current.series.ordinal) candidates.set(key, entry);
  }
  return [...candidates.values()]
    .sort((left, right) => left.series.family.localeCompare(right.series.family))
    .map(({ milestone }) => ({ id: milestone.id, number: milestone.number, title: milestone.title }));
}
