import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { DiscoveryServices } from "./services";

type CreateDiscoverySearchEmbeddingEnrichmentRunnersConfig = Readonly<{
  discoverySearchEmbeddings: Readonly<{ model: string; batchSize: number; intervalMs: number }>;
}>;
export function createDiscoverySearchEmbeddingEnrichmentRunners({
  services,
  config: input,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateDiscoverySearchEmbeddingEnrichmentRunnersConfig>,
  "services" | "config" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const discovery = services.discovery as DiscoveryServices | undefined;
  const runners: WorkerRunner[] = [];
  if (discovery?.searchEmbeddings) {
    runners.push(
      createScheduledJobRunner(
        "discovery.search-embedding-enrichment",
        input.discoverySearchEmbeddings.intervalMs,
        controlPlane,
        async () => {
          const result = await discovery.searchEmbeddings!.processNextBatch({
            limit: input.discoverySearchEmbeddings.batchSize,
          });
          if (result.processed > 0) {
            logger.info("Discovery search embedding enrichment batch completed.", {
              type: "discovery.search-embedding-enrichment",
              processed: result.processed,
              embedded: result.embedded,
              totalTokens: result.totalTokens,
              model: input.discoverySearchEmbeddings.model,
            });
          }
          return result.embedded;
        },
      ),
    );
  }
  return runners;
}
