import { classified } from "./backlog-classify.mjs";
import { compareOutcomeMilestones, isExecutableOutcome, readOutcomePolicy } from "./milestone-policy.mjs";

export function isRunnableRefined(issue) {
  if (!issue || issue.state !== "open" || !Array.isArray(issue.blockedBy) || !isExecutableOutcome(issue.milestone)) {
    return false;
  }
  const openBlockerCount = issue.blockedBy.filter((blocker) => blocker?.state === "open").length;
  return (
    openBlockerCount === 0 &&
    classified({
      number: issue.number,
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      issueTypeName: issue.issueTypeName,
      milestoneTitle: issue.milestone?.title ?? null,
      milestoneDescription: issue.milestone?.description ?? null,
      milestoneNumber: issue.milestone?.number ?? null,
      milestoneState: issue.milestone?.state ?? null,
      blockedByCount: openBlockerCount,
      hasParent: false,
    })
  );
}

/**
 * Select one pull milestone per exact outcome track. Input is the
 * normalized, complete authority published by roadmap-status; this helper has
 * no provider or mutation operation.
 */
export function derivePullWindow({ milestones, issues }) {
  const candidates = new Map();
  const milestoneById = new Map();
  for (const milestone of milestones) {
    if (!isExecutableOutcome(milestone)) continue;
    milestoneById.set(milestone.id, { milestone, policy: readOutcomePolicy(milestone) });
  }
  for (const issue of issues) {
    const entry = milestoneById.get(issue?.milestone?.id);
    if (!entry || !isRunnableRefined({ ...issue, milestone: entry.milestone })) continue;
    const key = entry.policy.track;
    const current = candidates.get(key);
    if (!current || compareOutcomeMilestones(entry.milestone, current.milestone) < 0) candidates.set(key, entry);
  }
  return [...candidates.values()]
    .sort((left, right) => compareOutcomeMilestones(left.milestone, right.milestone))
    .map(({ milestone }) => ({ id: milestone.id, number: milestone.number, title: milestone.title }));
}
