import { Hono } from "hono";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListId, SavedListLifecycleState, SavedListVisibility } from "../domain/contracts";
import { SavedListQueryError } from "../read-model/queries";
import type { SavedListReadModelServices } from "../read-model/runtime";
import type { CollectionsApiEnv } from "../../../api";

const visibilities = new Set<SavedListVisibility>(["private", "unlisted", "public"]);
const lifecycles = new Set<SavedListLifecycleState | "all">(["active", "archived", "all"]);

export function savedListQueryRoutes(services: SavedListReadModelServices) {
  const app = new Hono<CollectionsApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    const parsed = parseSummaryQuery(c.req.query());
    if (!parsed.ok) {
      return c.json({ error: { code: "invalid_query" } }, 400);
    }

    try {
      return c.json(
        await services.loadMyCollectionModule({
          ownerAccountId: actor.accountId as AccountId,
          ...parsed.value,
        }),
      );
    } catch (error) {
      if (error instanceof SavedListQueryError) {
        return c.json({ error: { code: "invalid_cursor" } }, 400);
      }
      throw error;
    }
  });

  app.get("/:listId", async (c) => {
    const actor = c.get("actor");
    const savedList = await services.loadDetail({
      ownerAccountId: actor.accountId as AccountId,
      listId: c.req.param("listId") as SavedListId,
    });
    if (!savedList) {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    return c.json({ contractVersion: 1 as const, savedList });
  });

  return app;
}

function parseSummaryQuery(query: Record<string, string>) {
  const visibilityValues = query.visibility
    ? query.visibility
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  if (visibilityValues.some((value) => !visibilities.has(value as SavedListVisibility))) {
    return { ok: false as const };
  }

  const lifecycle = query.lifecycle?.trim() || "active";
  if (!lifecycles.has(lifecycle as SavedListLifecycleState | "all")) {
    return { ok: false as const };
  }

  const parsedLimit = query.limit === undefined ? undefined : Number(query.limit);
  if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
    return { ok: false as const };
  }

  return {
    ok: true as const,
    value: {
      search: query.search,
      visibilities: visibilityValues as SavedListVisibility[],
      lifecycle: lifecycle as SavedListLifecycleState | "all",
      cursor: query.cursor,
      limit: parsedLimit,
    },
  };
}
