import type { WorkerRunner } from "@chase-sets/platform-runtime/worker";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import type { createEbayReceiptExpiryStore } from "../read-model/expiry";
import { ebayReceiptRetention } from "../domain/policy";

export function createEbayReceiptExpiryRunner(
  store: ReturnType<typeof createEbayReceiptExpiryStore>,
  logger: Readonly<{
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  }>,
  now: () => number = () => performance.now(),
  controlPlane?: Pick<PlatformControlPlane, "claimScheduledRunner" | "recordScheduledRunnerCompleted">,
): WorkerRunner {
  const intervalMs = ebayReceiptRetention.sweepSeconds * 500;
  let nextStart = 0;
  let retryAfter = 0;
  let sweep: { cutoff: string; started: number; deleted: number } | null = null;
  return {
    name: "channels.ebay-account-deletion-receipt-expiry",
    kind: "job",
    rescheduleOnCompletion: () => sweep !== null && now() >= retryAfter,
    async runOnce(context) {
      let processed = 0;
      let reason: "interrupted" | "deadline" | "database" = "database";
      const quantumStart = now();
      if (quantumStart < retryAfter) return { processed, lastGlobalPosition: "0" as never };
      if (!sweep && quantumStart < nextStart) return { processed, lastGlobalPosition: "0" as never };
      try {
        if (!sweep) {
          // Register fixed-start telemetry, but a retained due time must never
          // suppress the first cleanup after process restart. The worker lease
          // still serializes execution across replicas.
          await controlPlane?.claimScheduledRunner({
            runnerName: "channels.ebay-account-deletion-receipt-expiry",
            intervalMs,
          });
          sweep = { cutoff: await store.cutoff(), started: quantumStart, deleted: 0 };
          nextStart = quantumStart + intervalMs;
        }
        do {
          if (context?.signal?.aborted) {
            reason = "interrupted";
            throw new Error();
          }
          if (now() - sweep.started >= intervalMs) {
            reason = "deadline";
            throw new Error();
          }
          reason = "interrupted";
          context?.throwIfLeaseLost?.();
          reason = "database";
          const batch = await store.batch(sweep.cutoff);
          processed += batch.deleted;
          sweep.deleted += batch.deleted;
          if (context?.signal?.aborted) {
            reason = "interrupted";
            throw new Error();
          }
          if (now() - sweep.started >= intervalMs) {
            reason = "deadline";
            throw new Error();
          }
          reason = "interrupted";
          context?.throwIfLeaseLost?.();
          reason = "database";
          if (!batch.remaining) {
            await controlPlane?.recordScheduledRunnerCompleted({
              runnerName: "channels.ebay-account-deletion-receipt-expiry",
            });
            logger.info("eBay receipt cleanup completed.", {
              type: "channels.ebay-receipts.cleanup",
              deleted: sweep.deleted,
              elapsedMs: now() - sweep.started,
            });
            sweep = null;
            break;
          }
          // Locked rows remain work, but must not become a tight DB retry loop.
          if (batch.deleted === 0) {
            retryAfter = now() + 1000;
            break;
          }
        } while (now() - quantumStart < 1000);
        return { processed, lastGlobalPosition: "0" as never };
      } catch {
        logger.warn("eBay receipt cleanup incomplete.", {
          type: "channels.ebay-receipts.cleanup-incomplete",
          reason,
          deleted: sweep?.deleted ?? 0,
        });
        sweep = null;
        nextStart = 0;
        retryAfter = 0;
        throw new Error(`ebay-receipt-cleanup-incomplete:${reason}`);
      }
    },
  };
}
