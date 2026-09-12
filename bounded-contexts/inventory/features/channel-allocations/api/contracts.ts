import type { ChannelStockAllocation, SetChannelStockAllocationCommand } from "../domain/allocation";

export type ChannelStockAllocationHistoryFailureReason =
  | "unknown-event"
  | "unsupported-event-version"
  | "wrong-order-or-version"
  | "invalid-tail"
  | "inconsistent-history";

export type ChannelStockAllocationHistoryFailure = Readonly<{
  kind: "refused";
  code: "channel-stock-allocation-history-invalid";
  reason: ChannelStockAllocationHistoryFailureReason;
  eventIndex: number | null;
}>;

export type SetChannelStockAllocationResult =
  | Readonly<{ kind: "applied"; allocation: ChannelStockAllocation }>
  | Readonly<{
      kind: "refused";
      code: "channel-stock-allocation-revision-conflict";
      expectedRevision: number;
      actualRevision: number;
    }>
  | ChannelStockAllocationHistoryFailure;

export type SetChannelStockAllocation = (
  command: SetChannelStockAllocationCommand,
) => Promise<SetChannelStockAllocationResult>;

export type { ChannelStockAllocation, SetChannelStockAllocationCommand };
