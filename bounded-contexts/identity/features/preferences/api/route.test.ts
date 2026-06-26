import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import {
  decideUserPreferences,
  defaultUserPresentationPreferences,
  evolveUserPreferences,
  initialUserPreferencesState,
  type UserPreferencesState,
} from "../domain/domain";
import { userPreferencesRoutes } from "./route";
import type { UserPreferencesServices } from "./runtime";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
};

function buildContext(currentActor: ResolvedActor): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: currentActor.userId as never,
      forAccountId: currentActor.accountId as never,
    },
    trace: {},
  };
}

function buildApp(services: UserPreferencesServices, currentActor: ResolvedActor | null = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    if (currentActor) {
      c.set("context", buildContext(currentActor));
    }
    await next();
  });
  app.route("/preferences", userPreferencesRoutes(services));
  return app;
}

function buildServices() {
  let state: UserPreferencesState = initialUserPreferencesState;
  let version = 0;

  return {
    commandHandler: vi.fn(async (input) => {
      const events = decideUserPreferences(state, input.command);
      state = events.reduce(evolveUserPreferences, state);
      version += events.length;

      return {
        state,
        version,
        newEvents: events,
        storedEvents: [],
      };
    }),
    getUserPreferences: vi.fn(async (userId: string) => ({
      userId: userId as UserId,
      ...defaultUserPresentationPreferences,
    })),
    projectors: [],
  } satisfies UserPreferencesServices;
}

async function requestJson(app: Hono<IdentityApiEnv>, path: string, init: RequestInit = {}) {
  const response = await app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

describe("user preferences API route", () => {
  it("reads the authenticated user's resolved preferences with defaults when unset", async () => {
    const services = buildServices();

    const { response, body } = await requestJson(buildApp(services), "/preferences");

    expect(response.status).toBe(200);
    expect(services.getUserPreferences).toHaveBeenCalledWith(actor.userId);
    expect(body).toEqual({
      userId: actor.userId,
      ...defaultUserPresentationPreferences,
    });
  });

  it("updates the authenticated user's preferences and preserves untouched fields", async () => {
    const services = buildServices();
    const app = buildApp(services);

    const colorMode = await requestJson(app, "/preferences", {
      method: "PUT",
      body: JSON.stringify({ colorMode: "dark", locale: " en-us ", timeZone: " America/Chicago " }),
    });
    expect(colorMode.response.status).toBe(200);
    expect(colorMode.body).toMatchObject({
      id: actor.userId,
      version: 1,
      status: "updated",
      preferences: {
        userId: actor.userId,
        colorMode: "dark",
        density: "comfortable",
        reducedMotion: "user",
        locale: "en-US",
        timeZone: "America/Chicago",
      },
    });

    const density = await requestJson(app, "/preferences", {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });
    expect(density.response.status).toBe(200);
    expect(density.body.preferences).toEqual({
      userId: actor.userId,
      colorMode: "dark",
      density: "compact",
      reducedMotion: "user",
      locale: "en-US",
      timeZone: "America/Chicago",
    });
    expect(services.commandHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streamId: `identity.user-preferences-${actor.userId}`,
        command: {
          type: "SetUserPreferences",
          userId: actor.userId,
          density: "compact",
        },
      }),
    );
  });

  it("rejects cross-user preference writes before dispatching a command", async () => {
    const services = buildServices();

    const { response, body } = await requestJson(buildApp(services), "/preferences", {
      method: "PUT",
      body: JSON.stringify({ userId: "usr_2", colorMode: "light" }),
    });

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("authorization_forbidden");
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects invalid preference values with a validation error", async () => {
    const services = buildServices();

    const { response, body } = await requestJson(buildApp(services), "/preferences", {
      method: "PUT",
      body: JSON.stringify({ colorMode: "sepia" }),
    });

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "validation_failed",
      message: "Color mode must be system, light, or dark.",
    });
  });

  it("requires an authenticated actor", async () => {
    const services = buildServices();

    const read = await requestJson(buildApp(services, null), "/preferences");
    const write = await requestJson(buildApp(services, null), "/preferences", {
      method: "PUT",
      body: JSON.stringify({ colorMode: "dark" }),
    });

    expect(read.response.status).toBe(401);
    expect(write.response.status).toBe(401);
    expect(services.commandHandler).not.toHaveBeenCalled();
    expect(services.getUserPreferences).not.toHaveBeenCalled();
  });
});
