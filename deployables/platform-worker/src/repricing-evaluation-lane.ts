import type { Logger } from "@chase-sets/observability";
import type { RepricingEngineServices } from "@chase-sets/pricing/server";

export function processRepricingEvaluationJob(
  processNext: RepricingEngineServices["processNextEvaluationJob"],
  input: Parameters<RepricingEngineServices["processNextEvaluationJob"]>[0],
  logger: Pick<Logger, "info">,
): Promise<number> {
  return processNext({
    ...input,
    onSpiralBreakerTrip: (trip) => logger.info("pricing.repricing-spiral-breaker.tripped", { ...trip }),
  });
}
