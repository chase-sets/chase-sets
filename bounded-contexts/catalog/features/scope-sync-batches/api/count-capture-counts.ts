import type { z } from "zod";
import { countFingerprint, countQueryKey, countQuoteSchema, countTimeIsCurrent } from "../domain/count-acquisition";
import { countCapturePlannerInputSchema } from "../domain/count-capture-plan";
import { countCaptureAcquisitionInputSchema, countCaptureQuoteSchema } from "../domain/count-capture-counts";
import type { CountCaptureStore } from "../read-model/count-capture-store";
import type { createScopeSyncCountRuntime } from "./count-runtime";
import { CountCaptureStopped } from "./count-capture-context";
import { createCountCaptureSessionBoundary, type CountCaptureSession } from "./count-capture-session";

export type CountCaptureCountRuntime = ReturnType<typeof createCountCaptureCountRuntime>;

export function createCountCaptureCountRuntime(deps: {
  environment: string;
  store: Pick<CountCaptureStore, "findOwner" | "begin" | "finish" | "bindQuote" | "ledger">;
  counts: Pick<ReturnType<typeof createScopeSyncCountRuntime>, "quoteCounts" | "acquireCounts">;
  now?: () => string;
}) {
  const boundary = createCountCaptureSessionBoundary(deps);
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    quote(session: CountCaptureSession, value: z.infer<typeof countCapturePlannerInputSchema>) {
      const input = countCapturePlannerInputSchema.parse(value);
      return boundary.run(session, { ...input, phase: "quote" }, async (binding) => {
        // The ordinary engine lowers cap to the missing-kind count in this one
        // I/O-free quote. Binding rejects insufficient headroom or any other scope.
        const quote = countQuoteSchema.parse(
          await deps.counts.quoteCounts({ selection: input.selection, cap: 2, context: session.context }),
        );
        await deps.store.bindQuote(binding, quote);
        return countCaptureQuoteSchema.parse({
          quoteId: quote.quoteId,
          fingerprint: quote.fingerprint,
          plannedCount: quote.plannedCredits,
          serverCap: quote.cap,
        });
      });
    },
    acquire(session: CountCaptureSession, value: z.infer<typeof countCaptureAcquisitionInputSchema>) {
      const { quoteId, fingerprint, ...input } = countCaptureAcquisitionInputSchema.parse(value);
      return boundary.run(session, { ...input, phase: "acquisition", quote: { quoteId, fingerprint } }, async () => {
        // The existing count authority/claim/result path remains conjunctive
        // with the capture's durable possible-send ledger and no-redirect guard.
        const result = countQuoteSchema.parse(
          await deps.counts.acquireCounts({ quoteId, fingerprint, context: session.context }),
        );
        if (
          result.quoteId !== quoteId ||
          result.fingerprint !== fingerprint ||
          result.state !== "complete" ||
          countFingerprint(result.selection) !== countFingerprint(input.selection) ||
          result.targets.length !== 2 ||
          new Set(result.targets.map((target) => target.query.kind)).size !== 2 ||
          result.targets.some(
            (target) =>
              target.blocked ||
              !target.source ||
              countQueryKey(target.query) !== countQueryKey(target.source.query) ||
              !countTimeIsCurrent(target.source, now()),
          )
        )
          throw new CountCaptureStopped();
        return { retained: true as const };
      });
    },
  };
}
