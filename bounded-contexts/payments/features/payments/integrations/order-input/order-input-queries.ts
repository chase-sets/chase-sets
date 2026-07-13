import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { MarketplaceSalesFeeLineSnapshotPayload } from "@chase-sets/event-core";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import {
  toPublicListingEvidenceSnapshotGallery,
  type ListingEvidenceSnapshot,
  type MarketplaceListingPublicGalleryImage,
} from "../../../../support/request-support/listing-evidence";

export type PaymentOrderInputRow = Readonly<{
  order_id: string;
  buyer_account_id: string;
  buyer_email: string | null;
  shipping_destination_snapshot: AddressSnapshot | null;
  seller_account_id: string;
  sales_tax_amount: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_sales_fee_lines?: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  authenticity_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  shipping_allowance_amount: string;
  shipping_overage_amount: string;
  seller_shipping_payout_amount: string;
  protection_amount?: string;
  protection_allowance_amount?: string;
  protection_overage_amount?: string;
  seller_payout_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string;
  status: string;
  pending_payment_at: string | null;
  payment_deadline_at: string | null;
  payment_deadline_policy: string | null;
  listing_evidence: readonly Readonly<{
    line_id: string;
    item_title: string;
    gallery: readonly MarketplaceListingPublicGalleryImage[];
  }>[];
}>;

type PaymentOrderInputDbRow = Omit<PaymentOrderInputRow, "listing_evidence"> &
  Readonly<{ listing_evidence_snapshots: unknown }>;

export async function listPaymentOrderInputs(
  db: PgQueryable,
  orderIds: readonly OrderId[],
  buyerAccountId: AccountId,
): Promise<readonly PaymentOrderInputRow[]> {
  if (orderIds.length === 0) {
    return [];
  }

  const result = await db.query<PaymentOrderInputDbRow>(
    `SELECT
       order_id,
       buyer_account_id,
       buyer_email,
       shipping_destination_snapshot,
       seller_account_id,
       sales_tax_amount::text AS sales_tax_amount,
       total_amount::text AS total_amount,
       marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
       marketplace_sales_fee_lines,
       authenticity_fee_amount::text AS authenticity_fee_amount,
       marketplace_checkout_fee_amount::text AS marketplace_checkout_fee_amount,
       seller_net_amount::text AS seller_net_amount,
       seller_item_net_amount::text AS seller_item_net_amount,
        shipping_allowance_amount::text AS shipping_allowance_amount,
        shipping_overage_amount::text AS shipping_overage_amount,
        seller_shipping_payout_amount::text AS seller_shipping_payout_amount,
        protection_amount::text AS protection_amount,
        protection_allowance_amount::text AS protection_allowance_amount,
        protection_overage_amount::text AS protection_overage_amount,
        seller_payout_amount::text AS seller_payout_amount,
       shipping_allowance_percentage_bps,
       terms_schedule_id,
       terms_agreement_id,
       terms_resolved_at,
       status,
       pending_payment_at,
       payment_deadline_at,
       payment_deadline_policy,
       listing_evidence_snapshots
     FROM payments_order_inputs
     WHERE buyer_account_id = $1
       AND order_id = ANY($2)`,
    [buyerAccountId, orderIds],
  );

  return result.rows.map((row) => {
    const { listing_evidence_snapshots, ...safeRow } = row;
    return {
      ...safeRow,
      listing_evidence: Array.isArray(row.listing_evidence_snapshots)
        ? row.listing_evidence_snapshots.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const value = entry as Record<string, unknown>;
            const snapshot = value.listingEvidenceSnapshot;
            if (!snapshot || typeof snapshot !== "object") return [];
            return [
              {
                line_id: String(value.lineId ?? ""),
                item_title: String(value.itemTitle ?? "Item"),
                gallery: toPublicListingEvidenceSnapshotGallery(snapshot as ListingEvidenceSnapshot),
              },
            ];
          })
        : [],
    };
  });
}
