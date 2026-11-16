import type { WorkerRunner } from "@chase-sets/bounded-context-module";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import type { WorkerJobLogger } from "@chase-sets/platform-runtime/worker-jobs";
import type { EbayAccountDeletionConsumer } from "./consumer";
import { ebayReceiptRetention } from "../domain/policy";
import { EbayReceiptError } from "../domain/subject";

export function createEbayAccountDeletionConsumerRunner(
  consumer: EbayAccountDeletionConsumer,
  logger: Pick<WorkerJobLogger, "info" | "warn">,
  controlPlane?: Pick<PlatformControlPlane, "claimScheduledRunner" | "recordScheduledRunnerCompleted">,
  now: () => number = () => performance.now(),
): WorkerRunner {
  const name = "channels.ebay-account-deletion-consumer";
  const intervalMs = ebayReceiptRetention.sweepSeconds * 1000;
  let nextStart = 0;
  let after: string | null = null;
  let sweeping = false;
  return {
    name,
    kind: "job",
    rescheduleOnCompletion: () => sweeping,
    async runOnce(context) {
      let processed = 0;
      if (!sweeping && now() < nextStart) return { processed, lastGlobalPosition: "0" as never };
      try {
        if (!sweeping) {
          await controlPlane?.claimScheduledRunner({ runnerName: name, intervalMs });
          nextStart = now() + intervalMs;
          after = null;
          sweeping = true;
        }
        const batch = await consumer.batch(after);
        let unavailable = 0;
        for (const notificationId of batch) {
          context?.throwIfLeaseLost?.();
          if (context?.signal?.aborted) throw new Error();
          try {
            processed += await consumer.consume(notificationId);
          } catch (error) {
            if (!(error instanceof EbayReceiptError) || error.code !== "unavailable") throw error;
            unavailable++;
          }
          after = notificationId;
        }
        if (unavailable)
          logger.warn("eBay deletion subjects unavailable.", {
            type: "channels.ebay-deletion.unavailable",
            count: unavailable,
          });
        if (batch.length < ebayReceiptRetention.batchSize) {
          await controlPlane?.recordScheduledRunnerCompleted({ runnerName: name });
          sweeping = false;
        }
        logger.info("eBay deletion batch completed.", { type: "channels.ebay-deletion.batch", processed, unavailable });
        return { processed, lastGlobalPosition: "0" as never };
      } catch {
        sweeping = false;
        nextStart = 0;
        logger.warn("eBay deletion sweep incomplete.", { type: "channels.ebay-deletion.incomplete" });
        throw new Error("ebay-deletion-consumer-incomplete");
      }
    },
  };
}
