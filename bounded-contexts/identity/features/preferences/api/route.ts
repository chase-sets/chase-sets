import { Hono } from "hono";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import { userPreferencesFor, type UserPreferencesCommand } from "../domain/domain";
import type { UserPreferencesServices } from "./runtime";

type PreferencesBody = Partial<
  Readonly<{
    userId: unknown;
    colorMode: unknown;
    density: unknown;
    reducedMotion: unknown;
    locale: unknown;
    timeZone: unknown;
  }>
>;

function authenticationRequired() {
  return {
    error: {
      code: "authentication_required",
      message: "Authentication required.",
    },
  };
}

function forbidden() {
  return {
    error: {
      code: "authorization_forbidden",
      message: "Forbidden.",
    },
  };
}

function validationFailed(error: unknown) {
  return {
    error: {
      code: "validation_failed",
      message: error instanceof Error ? error.message : "User preferences are invalid.",
    },
  };
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function preferencesCommandFor(userId: string, body: PreferencesBody): UserPreferencesCommand {
  const command: Record<string, unknown> = {
    type: "SetUserPreferences",
    userId,
  };

  for (const key of ["colorMode", "density", "reducedMotion", "locale", "timeZone"] as const) {
    if (body[key] !== undefined) {
      command[key] = String(body[key]);
    }
  }

  return command as unknown as UserPreferencesCommand;
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

    const body = await c.req.json<PreferencesBody>();
    const requestedUserId = optionalString(body.userId);
    if (requestedUserId && requestedUserId !== actor.userId) {
      return c.json(forbidden(), 403);
    }

    try {
      const result = await services.commandHandler({
        streamId: `identity.user-preferences-${actor.userId}`,
        command: preferencesCommandFor(actor.userId, body),
        context,
      });

      return c.json({
        id: actor.userId,
        version: result.version,
        status: "updated",
        preferences: userPreferencesFor(actor.userId as UserId, result.state),
      });
    } catch (error) {
      if (error instanceof IdentityDomainError) {
        return c.json(validationFailed(error), 400);
      }

      throw error;
    }
  });

  return app;
}
