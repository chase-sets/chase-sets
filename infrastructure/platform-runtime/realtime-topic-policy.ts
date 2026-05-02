import type { ResolvedActor } from "./auth";

export const DEFAULT_MAX_TOPICS_PER_STREAM = 16;

const MAX_TOPIC_LENGTH = 160;
const TOPIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

type RealtimeTopicPolicy = Readonly<{
  name: string;
  match: (topic: string) => RealtimeTopicMatch | null;
  authorize: (match: RealtimeTopicMatch, actor: ResolvedActor | null) => boolean;
}>;

type RealtimeTopicMatch = Readonly<{
  family: string;
  accountId?: string;
  permission?: "listings.view" | "offers.view";
}>;

const realtimeTopicPolicies: readonly RealtimeTopicPolicy[] = [
  {
    name: "public-market",
    match: (topic) => topic === "public:market" ? { family: "public" } : null,
    authorize: () => true,
  },
  {
    name: "public-entity",
    match: (topic) => {
      const segments = topic.split(":");
      if (
        segments.length === 2 &&
        (segments[0] === "item" || segments[0] === "listing" || segments[0] === "seller") &&
        TOPIC_ID_PATTERN.test(segments[1] ?? "")
      ) {
        return { family: segments[0] };
      }

      return null;
    },
    authorize: () => true,
  },
  {
    name: "account-surface",
    match: (topic) => {
      const segments = topic.split(":");
      if (
        segments.length !== 3 ||
        segments[0] !== "account" ||
        !TOPIC_ID_PATTERN.test(segments[1] ?? "")
      ) {
        return null;
      }

      if (segments[2] === "listings") {
        return { family: "account", accountId: segments[1], permission: "listings.view" };
      }

      if (segments[2] === "offers") {
        return { family: "account", accountId: segments[1], permission: "offers.view" };
      }

      return null;
    },
    authorize: (match, actor) =>
      Boolean(
        actor &&
        match.accountId === actor.accountId &&
        match.permission &&
        actor.permissions.includes(match.permission),
      ),
  },
];

export type RealtimeTopicNormalizationDiagnostic = Readonly<{
  requestedCount: number;
  normalizedCount: number;
  duplicateCount: number;
  blankCount: number;
  sorted: boolean;
  invalidCount: number;
}>;

export function normalizeRealtimeTopics(topics: readonly string[]): readonly string[] {
  return [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))].sort();
}

export function inspectRealtimeTopicNormalization(
  topics: readonly string[],
): RealtimeTopicNormalizationDiagnostic {
  const trimmed = topics.map((topic) => topic.trim());
  const nonBlank = trimmed.filter(Boolean);
  const normalizedTopics = normalizeRealtimeTopics(topics);

  return {
    requestedCount: topics.length,
    normalizedCount: normalizedTopics.length,
    duplicateCount: Math.max(0, nonBlank.length - new Set(nonBlank).size),
    blankCount: trimmed.length - nonBlank.length,
    sorted: nonBlank.every((topic, index) => index === 0 || nonBlank[index - 1]! <= topic),
    invalidCount: normalizedTopics.filter((topic) => !resolveRealtimeTopicPolicy(topic)).length,
  };
}

export function authorizeRealtimeTopics(
  topics: readonly string[],
  actor: ResolvedActor | null,
): readonly string[] | null {
  const normalizedTopics = normalizeRealtimeTopics(topics);
  if (
    normalizedTopics.length === 0 ||
    normalizedTopics.length > DEFAULT_MAX_TOPICS_PER_STREAM ||
    !normalizedTopics.every((topic) => resolveRealtimeTopicPolicy(topic))
  ) {
    return null;
  }

  const allowed = normalizedTopics.every((topic) => {
    const policyMatch = resolveRealtimeTopicPolicy(topic);
    return policyMatch ? policyMatch.policy.authorize(policyMatch.match, actor) : false;
  });
  return allowed ? normalizedTopics : null;
}

export function resolveRealtimeTopicFamily(topic: string): string | null {
  return resolveRealtimeTopicPolicy(topic)?.match.family ?? null;
}

export function assertValidRealtimeTopics(topics: readonly string[]): void {
  if (topics.length > DEFAULT_MAX_TOPICS_PER_STREAM) {
    throw new Error(`Realtime subscriptions cannot include more than ${DEFAULT_MAX_TOPICS_PER_STREAM} topics.`);
  }

  const invalidTopic = topics.find((topic) => !resolveRealtimeTopicPolicy(topic));
  if (invalidTopic) {
    throw new Error(`Invalid realtime topic "${invalidTopic}".`);
  }
}

function resolveRealtimeTopicPolicy(topic: string): Readonly<{
  policy: RealtimeTopicPolicy;
  match: RealtimeTopicMatch;
}> | null {
  if (topic.length > MAX_TOPIC_LENGTH) {
    return null;
  }

  for (const policy of realtimeTopicPolicies) {
    const match = policy.match(topic);
    if (match) {
      return { policy, match };
    }
  }

  return null;
}
