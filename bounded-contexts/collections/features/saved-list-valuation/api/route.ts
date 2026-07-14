import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { t } from "@chase-sets/localization";
import { parseTypedId, type AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListId } from "../../saved-lists/domain";
import { Hono } from "hono";
import type { SavedListValuationServices } from "./runtime";

export function createSavedListValuationRoutes(services: SavedListValuationServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/saved-lists/:listId/valuation", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("collections.features.savedListValuation.api.authenticationRequired"),
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
            message: t("collections.features.savedListValuation.api.forbidden"),
          },
        },
        403,
      );
    }

    let listId: SavedListId;
    try {
      listId = parseTypedId(c.req.param("listId"), "svl");
    } catch {
      return c.json(
        {
          error: {
            code: "invalid_saved_list_id",
            message: t("collections.features.savedListValuation.api.invalidId"),
          },
        },
        400,
      );
    }

    const valuation = await services.getOwnerValuation({
      listId,
      ownerAccountId: actor.accountId as AccountId,
    });
    if (!valuation) {
      return c.json(
        {
          error: {
            code: "saved_list_not_found",
            message: t("collections.features.savedListValuation.api.notFound"),
          },
        },
        404,
      );
    }

    return c.json(valuation);
  });

  return app;
}
