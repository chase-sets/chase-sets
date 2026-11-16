import { createConnectionEpochs, type ConnectionEpochs } from "../../connections/api/owner-epochs";
import { fixture, keys, context } from "../../ebay-connection/tests/db-support";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { createEbayAccountDeletionConsumer } from "../api/consumer";
import { notice } from "./fixtures";

export { keys, context, owner, signal } from "../../ebay-connection/tests/db-support";
export function consumerFixture(suffix: string) {
  const f = fixture(`deletion_${suffix}`);
  function consumer(
    r: ReturnType<typeof f.runtime>,
    connectionEpochs: ConnectionEpochs = createConnectionEpochs(f.db()),
  ) {
    return createEbayAccountDeletionConsumer({
      db: f.db(),
      connectionEpochs,
      ebayConnection: r.service,
      connectorFeed: r.feed,
      context,
    });
  }
  async function record(notificationId = "synthetic-notice", subject = "synthetic-subject", active = "old") {
    return createEbayAccountDeletionRuntime(f.db(), keys(active)).recordEbayAccountDeletionReceipt(f.db(), {
      ...notice,
      notificationId,
      userId: subject,
    });
  }
  const completions = async () =>
    (await f.db().query("SELECT * FROM channels_ebay_account_deletion_completions ORDER BY connection_id")).rows;
  const identities = async () =>
    (
      await f
        .db()
        .query(
          "SELECT subject_fingerprint,subject_key_id,iv,ciphertext,tag,current_connection_id FROM channels_ebay_seller_bindings ORDER BY binding_id",
        )
    ).rows;
  return { ...f, consumer, record, completions, identities };
}
