import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import { canonicalPreferenceChanges } from "../domain/domain";
import { validatePreferenceKey } from "../domain/write-attempt";
import { appendUserPreferencesColorModeCookie } from "./color-mode-cookie";
import type { UserPreferencesServices } from "./runtime";
import { PreferenceWriteConflict } from "./runtime";

function authenticationRequired() {
  return {
    error: {
      code: "authentication_required",
      message: t("identity.features.preferences.api.route.authentication.required"),
    },
  };
}

function validationFailed() {
  return {
    error: {
      code: "validation_failed",
      message: t("identity.features.preferences.api.route.validation.failed"),
    },
  };
}

export function userPreferencesRoutes(services: UserPreferencesServices) {
  const app = new Hono<IdentityApiEnv>();

  app.get("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(authenticationRequired(), 401);
    }

    return c.json(await services.getUserPreferences(actor.userId));
  });

  app.put("/", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(authenticationRequired(), 401);
    }
    const context = c.var.context;
    if (!context) {
      return c.json(authenticationRequired(), 401);
    }

    const key = c.req.header("Idempotency-Key");
    let changes;
    try {
      validatePreferenceKey(key);
      changes = canonicalPreferenceChanges(await c.req.json<unknown>());
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof IdentityDomainError) return c.json(validationFailed(), 400);
      throw error;
    }

    try {
      const result = await services.writeUserPreferences({
        userId: actor.userId as UserId,
        key: key!,
        changes,
        context,
      });

      const response = c.json(result);
      appendUserPreferencesColorModeCookie(response.headers, result.preferences.colorMode, c.req.raw);
      return response;
    } catch (error) {
      if (error instanceof PreferenceWriteConflict) {
        return c.json({ error: { code: error.code, message: error.message }, preferences: error.preferences }, 409);
      }

      throw error;
    }
  });

  return app;
}
