import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import type { AccountManagementServices } from "../../account-management/api/runtime";
import { UserProfileFieldError } from "../domain/errors";
import type { UserServices } from "./runtime";
import { userRoutes } from "./route";

const userId = "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId,
  accountId: "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["security.manage"],
};

function buildApp(services: Partial<UserServices>, accountManagement?: AccountManagementServices) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/users", userRoutes(services as UserServices, accountManagement));
  return app;
}

describe("user API profile update", () => {
  it("refuses a direct update's blank display name with the field that is blank", async () => {
    const commandHandler = vi.fn(async () => {
      throw new UserProfileFieldError("displayName");
    });
    const response = await buildApp({ commandHandler: commandHandler as never }).request(`/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ displayName: "  ", givenName: "North" }),
      headers: { "Content-Type": "application/json" },
    });
    const message = "Display name is required.";
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "validation_failed", message, details: [{ field: "displayName", code: "required", message }] },
    });
  });

  it("answers a keyed update's blank display name as the field that is blank", async () => {
    const accountManagement = {
      submit: vi.fn(async () => ({
        outcome: "not-recorded",
        code: "validation-failed",
        userProfileField: "displayName",
      })),
      lookup: vi.fn(),
    } as unknown as AccountManagementServices;
    const response = await buildApp({}, accountManagement).request(`/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ displayName: " ", givenName: "", familyName: "" }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "c626f8c0-f697-4e78-82cf-ef162634f998" },
    });
    const message = "Display name is required.";
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "validation_failed", message, details: [{ field: "displayName", code: "required", message }] },
    });
  });
});
