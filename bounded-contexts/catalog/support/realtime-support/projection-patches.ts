import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import type { CatalogAdminRealtimeSurface } from "./topics";

export function createCatalogAdminInvalidationPatch(input: Readonly<{
  projectionName: string;
  surface: CatalogAdminRealtimeSurface;
  id: string;
  eventType: string;
  topics: readonly string[];
}>): RealtimeProjectionPatch {
  return {
    kind: "projection.patch",
    context: "catalog",
    projection: input.projectionName,
    topics: input.topics,
    changes: [
      {
        op: "summary",
        entity: "catalog.adminProjection",
        id: `${input.surface}:${input.id}`,
        value: {
          surface: input.surface,
          id: input.id,
          eventType: input.eventType,
        },
      },
    ],
  };
}
