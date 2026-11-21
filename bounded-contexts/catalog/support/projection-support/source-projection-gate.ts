import {
  createProjectionDependencyWaitError,
  hasProjectionAppliedEvent,
  localProjectionCheckpointKey,
} from "@chase-sets/bounded-context-runtime";
import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

// The Catalog projection that writes the table an admin page reads for each
// kind of event: `catalog.<kind>.<change>`.
const SOURCE_PROJECTION_BY_KIND: Readonly<Record<string, string>> = {
  blueprint: "catalog-blueprint-projection",
  category: "catalog-category-projection",
  component: "catalog-component-projection",
  dimension: "catalog-dimension-projection",
  field: "catalog-field-projection",
};

export function catalogSourceProjectionFor(eventType: string): string {
  const kind = eventType.split(".")[1] ?? "";
  const projectionName = SOURCE_PROJECTION_BY_KIND[kind];
  if (!projectionName) {
    throw new Error(`No Catalog source projection is known for ${eventType}.`);
  }
  return projectionName;
}

/**
 * An admin page projection builds its rows from tables other Catalog
 * projections write, and the subscriptions run independently. Each handler
 * here first waits for the projection that writes the event's table to have
 * applied the event; until then it fails as a dependency wait, so the
 * subscription retries the event instead of building the page from a row that
 * is missing or behind.
 */
export function afterCatalogSourceProjections(handlers: ProjectorHandlerMap, db: PgQueryable): ProjectorHandlerMap {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => {
      const sourceProjectionName = catalogSourceProjectionFor(eventType);
      const sourceProjectionKey = localProjectionCheckpointKey("catalog", sourceProjectionName);
      return [
        eventType,
        async (...args: Parameters<ProjectorHandlerMap[string]>) => {
          const [event, context] = args;
          const applied = await hasProjectionAppliedEvent(resolveProjectionDb(context, db), sourceProjectionKey, {
            id: String(event.id),
            streamId: event.streamId,
            globalPosition: String(event.globalPosition),
          });
          if (!applied) {
            throw createProjectionDependencyWaitError(
              `${sourceProjectionName} has not applied ${eventType} ${event.id} yet.`,
              String(event.id),
            );
          }
          await handler(event, context);
        },
      ];
    }),
  );
}
