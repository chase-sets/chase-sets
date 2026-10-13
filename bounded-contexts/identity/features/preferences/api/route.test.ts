import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityApiEnv } from "../../../api";
import { defaultUserPresentationPreferences } from "../domain/domain";
import { USER_PREFERENCES_COLOR_MODE_COOKIE_NAME } from "./color-mode-cookie";
import { userPreferencesRoutes } from "./route";
import type { UserPreferencesServices } from "./runtime";
import { createUserPreferencesRuntime } from "./runtime";

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
  const services = createUserPreferencesRuntime({
    eventStore: createInMemoryEventStore().eventStore,
    db: { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) },
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
  });
  return {
    ...services,
    writeUserPreferences: vi.fn(services.writeUserPreferences),
    getUserPreferences: vi.fn(services.getUserPreferences),
  };
}

async function requestJson(app: Hono<IdentityApiEnv>, path: string, init: RequestInit = {}) {
  const response = await app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      ...init.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

describe("user preferences API route", () => {
  it("preference-write-closed-request-contract", async () => {
    const services = buildServices();
    const app = buildApp(services);
    const validationError = {
      error: { code: "validation_failed", message: t("identity.features.preferences.api.route.validation.failed") },
    };
    expect(validationError.error.message).toBe("User preferences are invalid.");
    for (const body of [
      "{",
      "null",
      "1",
      '"dark"',
      "[]",
      "{}",
      '{"userId":"usr_1"}',
      '{"colorMode":{"value":"dark"}}',
      '{"colorMode":"dark","other":true}',
    ]) {
      const response = await app.request("/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "attempt-1" },
        body,
      });
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual(validationError);
    }
    for (const key of [undefined, "", "x".repeat(129), "non-ascii-é"]) {
      const response = await app.request("/preferences", {
        method: "PUT",
        headers: key === undefined ? {} : { "Idempotency-Key": key },
        body: '{"colorMode":"dark"}',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(validationError);
    }
    expect(services.writeUserPreferences).not.toHaveBeenCalled();
    expect(services.getUserPreferences).not.toHaveBeenCalled();
    for (const field of Object.keys(defaultUserPresentationPreferences)) {
      for (const scalar of [null, true, 1, [], {}, "", "x".repeat(129)]) {
        const response = await app.request("/preferences", {
          method: "PUT",
          headers: { "Idempotency-Key": "attempt" },
          body: JSON.stringify({ [field]: scalar }),
        });
        expect(response.status, `${field}/${JSON.stringify(scalar)}`).toBe(400);
        expect(await response.json()).toEqual(validationError);
      }
    }
    expect(services.writeUserPreferences).not.toHaveBeenCalled();
    for (const field of Object.keys(defaultUserPresentationPreferences)) {
      const response = await app.request("/preferences", {
        method: "PUT",
        headers: { "Idempotency-Key": `${field}-valid` },
        body: JSON.stringify({
          [field]: defaultUserPresentationPreferences[field as keyof typeof defaultUserPresentationPreferences],
        }),
      });
      expect(response.status, field).toBe(200);
      expect((await response.json()).receipt.changes).toEqual({
        [field]: defaultUserPresentationPreferences[field as keyof typeof defaultUserPresentationPreferences],
      });
    }
  });
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
    expect(colorMode.response.headers.get("Set-Cookie")).toContain(`${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=dark`);

    const density = await requestJson(app, "/preferences", {
      method: "PUT",
      body: JSON.stringify({ density: "compact" }),
    });
    expect(density.response.status).toBe(200);
    expect(density.response.headers.get("Set-Cookie")).toContain(`${USER_PREFERENCES_COLOR_MODE_COOKIE_NAME}=dark`);
    expect(density.body.preferences).toEqual({
      userId: actor.userId,
      colorMode: "dark",
      density: "compact",
      reducedMotion: "user",
      locale: "en-US",
      timeZone: "America/Chicago",
    });
    expect(services.writeUserPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: actor.userId,
        changes: { density: "compact" },
      }),
    );
  });

  it("rejects cross-user preference writes before dispatching a command", async () => {
    const services = buildServices();

    const { response, body } = await requestJson(buildApp(services), "/preferences", {
      method: "PUT",
      body: JSON.stringify({ userId: "usr_2", colorMode: "light" }),
    });

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(services.writeUserPreferences).not.toHaveBeenCalled();
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
      message: "User preferences are invalid.",
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
    expect(services.writeUserPreferences).not.toHaveBeenCalled();
    expect(services.getUserPreferences).not.toHaveBeenCalled();
  });
  it("preference-write-user-isolation payload-log secret scan", async () => {
    const services = buildServices();
    const app = buildApp(services);
    const secret = "private-opaque-key-never-disclosed";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = await requestJson(app, "/preferences", {
        method: "PUT",
        headers: { "Idempotency-Key": secret },
        body: '{"colorMode":"dark"}',
      });
      const conflict = await requestJson(app, "/preferences", {
        method: "PUT",
        headers: { "Idempotency-Key": secret },
        body: '{"colorMode":"light"}',
      });
      expect(conflict.response.status).toBe(409);
      expect(conflict.body.preferences.userId).toBe(actor.userId);
      expect(JSON.stringify({ first: first.body, conflict: conflict.body, logs: log.mock.calls })).not.toContain(
        secret,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
