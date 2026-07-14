import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { DiscoveryApiEnv } from "../../../api";
import type { DiscoveryRecentSavedListsResponse } from "./contracts";
import type { SavedListPickerServices } from "./runtime";

/** Serves the local Saved List picker view without a request-path Collections read. */
export function createSavedListPickerRoutes(services: SavedListPickerServices) {
  const app = new Hono<DiscoveryApiEnv>();

  app.get("/recent", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("collections.features.savedLists.api.route.sign.in.required"),
          },
        },
        401,
      );
    }
    if (!actor.permissions.includes("accounts.view")) {
      return c.json(
        {
          error: {
            code: "authorization_forbidden",
            message: t("collections.features.savedLists.api.route.account.forbidden"),
          },
        },
        403,
      );
    }

    const items = await services.listRecent({ ownerAccountId: actor.accountId });
    return c.json({ items, total: items.length, count: items.length } satisfies DiscoveryRecentSavedListsResponse);
  });

  return app;
}
