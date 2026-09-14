// Presentation copy for Seller Desk attention items. The read model stays
// presentation-free — it carries a stable semantic `code` plus typed params —
// and the Desk home renders its own localized copy from that code here. Keeping
// the code→copy map in one place means the queue wording lives beside the
// surface that shows it, never inside the transport-agnostic read model.

import { t } from "@chase-sets/localization";
import type {
  SellerAttentionItem,
  SellerAttentionSeverity,
  SellerAttentionSourceId,
} from "@chase-sets/seller-attention-queue";

type BadgeTone = "danger" | "warning" | "info";

export function severityTone(severity: SellerAttentionSeverity): BadgeTone {
  switch (severity) {
    case "critical":
      return "danger";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

export function severityLabel(severity: SellerAttentionSeverity): string {
  switch (severity) {
    case "critical":
      return t("marketplace.features.sellerDesk.severity.critical");
    case "warning":
      return t("marketplace.features.sellerDesk.severity.warning");
    case "info":
      return t("marketplace.features.sellerDesk.severity.info");
  }
}

// Render one attention item's summary line from its semantic code and params.
// An unknown code falls back to a neutral label so a new source never renders a
// raw code string to the seller.
export function resolveAttentionSummary(item: SellerAttentionItem): string {
  const params = item.summary.params;
  switch (item.summary.code) {
    case "ship-by-overdue":
      return t("marketplace.features.sellerDesk.summary.shipByOverdue", params);
    case "ship-by-soon":
      return t("marketplace.features.sellerDesk.summary.shipBySoon", params);
    case "ship-by-upcoming":
      return t("marketplace.features.sellerDesk.summary.shipByUpcoming", params);
    case "payout-blocked":
      return t("marketplace.features.sellerDesk.summary.payoutBlocked", params);
    case "import-rows-unresolved":
      return t("marketplace.features.sellerDesk.summary.importRowsUnresolved", params);
    case "offer-awaiting-response":
      return t("marketplace.features.sellerDesk.summary.offerAwaitingResponse", params);
    case "listing-needs-action":
      return t("marketplace.features.sellerDesk.summary.listingNeedsAction", params);
    case "channel-ready":
      return t("channels.manualSync.attention.ready", params);
    case "channel-unknown":
      return t("channels.manualSync.attention.unknown", params);
    case "channel-recovery":
      return t("channels.manualSync.attention.recovery", params);
    case "channel-action-open": {
      const health = t("marketplace.features.sellerDesk.summary.channelActionOpen", {
        ...params,
        topReason: channelHealthReasonLabel(params.topReason),
      });
      const manual =
        params.manualReason === "ready"
          ? t("channels.manualSync.attention.ready", params)
          : params.manualReason === "unknown"
            ? t("channels.manualSync.attention.unknown", params)
            : params.manualReason === "recovery"
              ? t("channels.manualSync.attention.recovery", params)
              : null;
      return manual === null ? health : `${health} ${manual}`;
    }
    default:
      return t("marketplace.features.sellerDesk.summary.fallback");
  }
}

// The deep-link call to action — a verb that reflects the fix the row leads to,
// keyed by the owning source so opening the queue row reads as the seller job.
export function attentionActionLabel(item: SellerAttentionItem): string {
  switch (item.source) {
    case "fulfillment-ship-by":
      return t("marketplace.features.sellerDesk.action.shipByLink");
    case "settlement-blocked-payout":
      return t("marketplace.features.sellerDesk.action.payoutLink");
    case "inventory-resolution":
      return t("marketplace.features.sellerDesk.action.resolutionLink");
    case "channel-action":
      return item.summary.code !== "channel-action-open" || item.summary.params.manualReason !== undefined
        ? t("channels.manualSync.attention.action")
        : t("marketplace.features.sellerDesk.action.channelAttention");
    case "offer-response":
      return t("marketplace.features.sellerDesk.action.offerLink");
    case "listing-action":
      return t("marketplace.features.sellerDesk.action.listingLink");
    case "dispute-response":
      return t("marketplace.features.sellerDesk.action.disputeLink");
  }
}

// The human label for a degraded source, so the "source unavailable" marker
// names which signal is temporarily missing rather than showing a raw id.
export function attentionSourceLabel(source: SellerAttentionSourceId): string {
  switch (source) {
    case "fulfillment-ship-by":
      return t("marketplace.features.sellerDesk.source.fulfillmentShipBy");
    case "settlement-blocked-payout":
      return t("marketplace.features.sellerDesk.source.settlementBlockedPayout");
    case "inventory-resolution":
      return t("marketplace.features.sellerDesk.source.inventoryResolution");
    case "channel-action":
      return t("marketplace.features.sellerDesk.source.channelAction");
    case "offer-response":
      return t("marketplace.features.sellerDesk.source.offerResponse");
    case "listing-action":
      return t("marketplace.features.sellerDesk.source.listingAction");
    case "dispute-response":
      return t("marketplace.features.sellerDesk.source.disputeResponse");
  }
}

function channelHealthReasonLabel(value: string | number | undefined): string {
  switch (value) {
    case "credential":
      return t("channels.attention.reason.credential");
    case "seller-setup":
      return t("channels.attention.reason.seller-setup");
    case "subscription":
      return t("channels.attention.reason.subscription");
    case "polling":
      return t("channels.attention.reason.polling");
    case "drift":
      return t("channels.attention.reason.drift");
    case "provider-rate":
      return t("channels.attention.reason.provider-rate");
    case "provider-availability":
      return t("channels.attention.reason.provider-availability");
    case "sale-follow-up":
      return t("channels.attention.reason.sale-follow-up");
    default:
      return t("marketplace.features.sellerDesk.source.channelAction");
  }
}
