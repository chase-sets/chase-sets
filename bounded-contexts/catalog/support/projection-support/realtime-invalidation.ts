import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { createCatalogAdminInvalidationPatch } from "../realtime-support/projection-patches";
import {
  catalogRealtimeTopicPolicyManifest,
  catalogRealtimeTopics,
  type CatalogAdminRealtimeSurface,
} from "../realtime-support/topics";

export function withCatalogAdminRealtimeInvalidation(
  handlers: ProjectorHandlerMap,
  db: PgQueryable,
  input: Readonly<{
    projectionName: string;
    surface: CatalogAdminRealtimeSurface;
    shouldInvalidate?: (eventType: string, event: Parameters<ProjectorHandlerMap[string]>[0]) => boolean;
  }>,
): ProjectorHandlerMap {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => [
      eventType,
      async (...args: Parameters<ProjectorHandlerMap[string]>) => {
        const [event, context] = args;
        await handler(event, context);
        if (input.shouldInvalidate && !input.shouldInvalidate(eventType, event)) {
          return;
        }

        const id = event.streamId || eventType;
        const topics = [catalogRealtimeTopics.adminSurface(input.surface)];
        await recordRealtimeProjectionPatch(resolveProjectionDb(context, db), {
          sourceGlobalPosition: event.globalPosition,
          projectionName: input.projectionName,
          patchKey: `${input.surface}:${id}`,
          topics,
          topicPolicyManifest: catalogRealtimeTopicPolicyManifest,
          recordedAt: event.timing.recordedAt,
          patch: createCatalogAdminInvalidationPatch({
            projectionName: input.projectionName,
            surface: input.surface,
            id,
            eventType,
            topics,
          }),
        });
      },
    ]),
  );
}
