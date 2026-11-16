import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelCredentialBinding } from "../../credentials/api/runtime";
import { ChannelCredentialError } from "../../credentials/domain/contracts";

export type EbaySellerBinding = {
  binding_id: string;
  account_id: string;
  environment: "sandbox" | "production";
  subject_fingerprint: string;
  subject_key_id: string;
  current_connection_id: string | null;
  credential_reference: string | null;
  capabilities: string[];
};
export async function lockEbayConnectionBinding(db: PgQueryable, connectionId: string) {
  return (
    (
      await db.query<EbaySellerBinding>(
        `SELECT * FROM channels_ebay_seller_bindings
    WHERE current_connection_id=$1 OR binding_id=(SELECT binding_id FROM channels_ebay_disconnect_records WHERE connection_id=$1)
    FOR UPDATE`,
        [connectionId],
      )
    ).rows[0] ?? null
  );
}
export async function fenceEbayCredential(db: PgQueryable, binding: ChannelCredentialBinding) {
  if (binding.providerKey !== "ebay") return;
  const current = await lockEbayConnectionBinding(db, binding.connectionId);
  if (
    !current ||
    current.current_connection_id !== binding.connectionId ||
    current.account_id !== binding.accountId ||
    current.environment !== binding.environment
  )
    throw new ChannelCredentialError("conflict");
}
