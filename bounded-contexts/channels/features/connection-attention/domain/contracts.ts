import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  ChannelHealthQuery,
  ChannelHealthReasonGeneration,
  ChannelHealthState,
} from "../../connection-health/domain/contracts";
import type { ManualAttentionContribution } from "../../manual-sync/read-model/attention-query";

export const channelAttentionResolutions = [
  "handled-on-channel",
  "reconnected",
  "reselected-setup",
  "recovered-automatically",
  "inventory-adjusted-separately",
  "no-action-required",
] as const;
export type ChannelAttentionResolution = (typeof channelAttentionResolutions)[number];
export type ChannelAttentionResolve = Readonly<{
  connection: ChannelHealthQuery;
  reasonCode: ChannelHealthReasonGeneration["reasonCode"];
  generation: number;
  resolutionReason: ChannelAttentionResolution;
}>;
export type ChannelAttentionFact = Readonly<{
  schemaVersion: "ChannelAttentionOpened/v1" | "ChannelAttentionResolved/v1";
  connection: ChannelHealthQuery;
  reasonCode: ChannelHealthReasonGeneration["reasonCode"];
  generation: number;
  resolutionReason: ChannelAttentionResolution | null;
  openedAt: string;
  resolvedAt: string | null;
}>;
export type ChannelConnectionAttention = Readonly<{
  connectionId: string;
  healthState: ChannelHealthState;
  health: readonly ChannelHealthReasonGeneration[];
  manual: ManualAttentionContribution | null;
  drift?: Readonly<{ affectedListingCount: number; hasMore: 0 | 1 }>;
}>;
export type ConnectionAttentionServices = Readonly<{
  listOpenAttention: (
    input: Readonly<{ accountId: string; connectionId?: string }>,
  ) => Promise<readonly ChannelConnectionAttention[]>;
  resolveAttention: (
    input: ChannelAttentionResolve,
    context: EventStoreContext,
  ) => Promise<Readonly<{ outcome: "resolved" | "inert" | "stale" }>>;
}>;
export class ChannelAttentionError extends Error {
  constructor(readonly code: "invalid-attention-contract" | "connection-not-found") {
    super(code);
    this.name = "ChannelAttentionError";
  }
}
