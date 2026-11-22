import type { RealtimeTopicManifest, RealtimeTopicPolicyManifest } from "@chase-sets/platform-runtime/realtime";

// The one topic the Operations Attention queue rides. Every queue source that
// Platform Operations projects publishes an invalidation here, so the page
// refreshes its queue when any of them changes.
export const OPERATIONS_ATTENTION_REALTIME_TOPIC = "platform-operations:admin:operations-attention";

// The queue page is gated on projection operations, so the topic admits the
// same staff.
export const OPERATIONS_ATTENTION_REALTIME_PERMISSION = "projection-operations.view";

export const platformOperationsRealtimeTopics = {
  operationsAttention: () => OPERATIONS_ATTENTION_REALTIME_TOPIC,
} as const;

export const platformOperationsRealtimeManifest = {
  contextName: "platform-operations",
  topics: platformOperationsRealtimeTopics,
  exactTopics: [OPERATIONS_ATTENTION_REALTIME_TOPIC],
} satisfies RealtimeTopicManifest<typeof platformOperationsRealtimeTopics>;

export const platformOperationsRealtimeTopicPolicyManifest = {
  contextName: "platform-operations",
  policies: [
    {
      name: "platform-operations-attention",
      match: (topic) => (topic === OPERATIONS_ATTENTION_REALTIME_TOPIC ? { family: "admin" } : null),
      authorize: (_match, actor) => actor?.permissions.includes(OPERATIONS_ATTENTION_REALTIME_PERMISSION) ?? false,
    },
  ],
} satisfies RealtimeTopicPolicyManifest;
