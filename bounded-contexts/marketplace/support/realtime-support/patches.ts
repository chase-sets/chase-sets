import type { ListResponse } from "@chase-sets/http/responses";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";

export function applyMarketplaceListPatch<T>(
  data: ListResponse<T>,
  patch: RealtimeProjectionPatch,
  options: Readonly<{
    entity: string;
    idField: keyof T;
  }>,
): ListResponse<T> {
  let next = data;

  for (const change of patch.changes) {
    if (change.entity !== options.entity) {
      continue;
    }

    const index = next.items.findIndex((item) => String(item[options.idField]) === change.id);

    if (change.op === "remove") {
      if (index === -1) {
        continue;
      }

      const items = next.items.filter((item) => item[options.idField] !== change.id);
      next = {
        ...next,
        items,
        total: Math.max(0, next.total - 1),
        count: items.length,
      };
      continue;
    }

    if (change.op !== "upsert") {
      continue;
    }

    const value = change.value as T;
    if (index === -1) {
      if (next.count < next.total) {
        continue;
      }

      const items = [value, ...next.items];
      next = {
        ...next,
        items,
        total: next.total + 1,
        count: items.length,
      };
      continue;
    }

    const items = [...next.items];
    items[index] = value;
    next = {
      ...next,
      items,
    };
  }

  return next;
}
