import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseSetupSelection, type SetupSelection } from "../domain/setup-selection";

export async function readSetupSelection(
  db: PgQueryable,
  accountId: string,
  connectionId: string,
): Promise<SetupSelection | null> {
  const row = (
    await db.query<{ selection: unknown }>(
      "SELECT selection FROM channels_ebay_seller_setup WHERE connection_id=$1 AND account_id=$2",
      [connectionId, accountId],
    )
  ).rows[0];
  return row ? parseSetupSelection(row.selection) : null;
}
export async function resolveEbaySetupPolicy(
  db: PgQueryable,
  input: { accountId: string; connectionId: string; policyKey: string },
) {
  const selection = await readSetupSelection(db, input.accountId, input.connectionId);
  return {
    policyKey: input.policyKey,
    revision: selection?.setupGeneration ?? 0,
    status: selection?.policies.some((item) => `ebay.${item.policyType}` === input.policyKey)
      ? ("complete" as const)
      : ("incomplete" as const),
  };
}
