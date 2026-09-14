import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildSellerAttentionItem, type SellerAttentionSource } from "@chase-sets/seller-attention-queue";
import type { ChannelConnectionAttention } from "../domain/contracts";
import { readConnectionAttention } from "./query";

export function createChannelActionAttentionSource(
  loadRows: (accountId: string) => Promise<readonly ChannelConnectionAttention[]>,
): SellerAttentionSource {
  return {
    id: "channel-action",
    load: async ({ accountId }) =>
      (await loadRows(accountId)).flatMap((row) => {
        const reasons = [...row.health].sort(
          (a, b) =>
            Number(b.state === "failing") - Number(a.state === "failing") ||
            Date.parse(a.opening.occurredAt) - Date.parse(b.opening.occurredAt) ||
            a.reasonCode.localeCompare(b.reasonCode),
        );
        const top = reasons[0];
        if (!top && !row.manual) return [];
        const summary = top
          ? {
              code: "channel-action-open",
              params: {
                reasonCount: reasons.length,
                topReason: top.reasonCode,
                ...(row.manual ? { manualReason: row.manual.reason, connectionId: row.connectionId } : {}),
              },
            }
          : { code: `channel-${row.manual!.reason}`, params: { connectionId: row.connectionId } };
        const observations = [
          ...reasons.map((reason) => reason.opening.occurredAt),
          ...(row.manual ? [row.manual.observedAt] : []),
        ];
        return [
          buildSellerAttentionItem({
            source: "channel-action",
            entityId: row.connectionId,
            severity:
              top?.state === "failing" ? "critical" : top || row.manual?.reason !== "ready" ? "warning" : "info",
            summary,
            observedAt: observations.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)),
          }),
        ];
      }),
  };
}
export function createChannelActionAttentionSourceFromReadModel(db: PgQueryable): SellerAttentionSource {
  return createChannelActionAttentionSource(async (accountId) => {
    try {
      return await readConnectionAttention(db, { accountId });
    } catch {
      throw new Error("channel-action-unavailable");
    }
  });
}
