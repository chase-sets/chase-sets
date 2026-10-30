import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { IdentityApiEnv } from "../../../api";
import type { AccountServices } from "./runtime";
import { accountRoutes } from "./route";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.manage", "accounts.view"],
};

const platformAdminActor: ResolvedActor = {
  ...actor,
  accountId: "acc_platform",
  membershipId: "mbr_platform",
  roleKey: "platform-admin",
};

function buildApp(services: AccountServices, resolvedActor: ResolvedActor = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", resolvedActor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: resolvedActor.userId as never,
        forAccountId: resolvedActor.accountId as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/accounts", accountRoutes(services));
  return app;
}

function buildServices(overrides: Partial<AccountServices> = {}) {
  return {
    commandHandler: vi.fn(async () => ({
      state: { status: "active", badges: ["founding-account"] },
      version: 2,
    })),
    listAccounts: vi.fn(async () => ({ items: [], total: 0 })),
    getAccount: vi.fn(async () => null),
    getAccountForRead: vi.fn(async () => null),
    getAccountState: vi.fn(async () => null),
    projectors: [],
    ...overrides,
  } as AccountServices;
}

function buildAppWithoutActor(services: AccountServices, missingActor: null | undefined) {
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    if (missingActor === null) c.set("actor", null);
    // Anonymous requests still carry a well-formed bootstrap context; authority must come from the actor.
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: "usr_bootstrap" as never,
        forAccountId: "acc_bootstrap" as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/accounts", accountRoutes(services));
  return app;
}

describe.each([null, undefined])("account API without an actor (%s)", (missingActor) => {
  it("create account fails closed without an actor", async () => {
    const services = buildServices();
    const response = await buildAppWithoutActor(services, missingActor).request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acc_1", name: "Test Account", accountType: "personal" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authentication_required" } });
    expect(services.commandHandler).not.toHaveBeenCalled();
    expect(services.getAccountForRead).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", path: "/accounts/acc_1", key: undefined },
    { method: "PUT", path: "/accounts/acc_1", key: undefined },
    { method: "PUT", path: "/accounts/acc_1", key: "c626f8c0-f697-4e78-82cf-ef162634f998" },
    { method: "POST", path: "/accounts/acc_1/suspend", key: undefined },
    { method: "POST", path: "/accounts/acc_1/reactivate", key: undefined },
    { method: "POST", path: "/accounts/acc_1/close", key: undefined },
  ])("manage account fails closed without an actor: $method $path ($key)", async ({ method, path, key }) => {
    const services = buildServices();
    const response = await buildAppWithoutActor(services, missingActor).request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(method === "PUT" ? { body: JSON.stringify({ name: "Updated Account" }) } : {}),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authorization_forbidden" } });
    expect(services.getAccountForRead).not.toHaveBeenCalled();
    expect(services.commandHandler).not.toHaveBeenCalled();
  });
});

describe("account API route", () => {
  it.each([
    ["suspend", "SuspendAccount", "/accounts/acc_1/suspend"],
    ["reactivate", "ReactivateAccount", "/accounts/acc_1/reactivate"],
    ["close", "CloseAccount", "/accounts/acc_1/close"],
  ])("keeps no-body and empty-object %s requests compatible", async (_action, commandType, path) => {
    for (const init of [
      { method: "POST" },
      { method: "POST", body: "" },
      { method: "POST", body: "{}" },
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
    ]) {
      const services = buildServices();
      const response = await buildApp(services).request(path, init);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "acc_1", version: 2, status: "active" });
      expect(services.commandHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            type: commandType,
            enforcement: {
              version: 1,
              enforcementActionId: expect.stringMatching(/^enf_[0-9A-HJKMNP-TV-Z]{26}$/),
              reason: "operator-other",
              reference: null,
            },
          },
        }),
      );
    }
  });

  it.each([
    ["suspend", "/accounts/acc_1/suspend", "policy-violation"],
    ["reactivate", "/accounts/acc_1/reactivate", "appeal-upheld"],
    ["close", "/accounts/acc_1/close", "seller-requested"],
  ])("forwards complete structured %s provenance", async (_action, path, reason) => {
    const services = buildServices();
    const body = {
      reason,
      reference: {
        kind: "support-request",
        supportRequestId: "sup_01ARYZ6S41TSV4RRFFQ69G5FAV",
      },
    };
    const response = await buildApp(services).request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          enforcement: expect.objectContaining(body),
        }),
      }),
    );
  });

  it.each([
    ["partial", "/accounts/acc_1/suspend", { reason: "policy-violation" }],
    ["wrong suspend union", "/accounts/acc_1/suspend", { reason: "appeal-upheld", reference: null }],
    ["wrong reversal union", "/accounts/acc_1/reactivate", { reason: "payment-risk", reference: null }],
    ["unknown member", "/accounts/acc_1/close", { reason: "operator-other", reference: null, note: "x" }],
    [
      "malformed reference",
      "/accounts/acc_1/close",
      { reason: "operator-other", reference: { kind: "support-request", supportRequestId: "sup_" } },
    ],
  ])("returns 400 for a %s enforcement request", async (_case, path, body) => {
    const services = buildServices();
    const response = await buildApp(services).request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "validation_failed" } });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it.each(["suspend", "reactivate", "close"])(
    "preserves %s authorization before reading operator provenance",
    async (action) => {
      const services = buildServices();
      const unrelatedActor = { ...actor, accountId: "acc_other" };
      const response = await buildApp(services, unrelatedActor).request(`/accounts/acc_1/${action}`, {
        method: "POST",
        body: "not-json",
      });

      expect(response.status).toBe(403);
      expect(services.commandHandler).not.toHaveBeenCalled();
    },
  );

  it("returns 400 for malformed nonempty JSON", async () => {
    const services = buildServices();
    const response = await buildApp(services).request("/accounts/acc_1/suspend", {
      method: "POST",
      body: "not-json",
    });

    expect(response.status).toBe(400);
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["assign", "/accounts/acc_1/badges", { method: "POST", body: JSON.stringify({ badgeKey: "trusted-seller" }) }],
    ["remove", "/accounts/acc_1/badges/manual-payout-review", { method: "DELETE" }],
  ])("rejects an account owner attempting to %s a badge on their own account", async (_action, path, init) => {
    const services = buildServices();

    const response = await buildApp(services).request(path, {
      ...init,
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authorization_forbidden" },
    });
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("allows a platform admin to assign an account badge", async () => {
    const services = buildServices({
      commandHandler: vi.fn(async () => ({
        state: { status: "active", badges: ["trusted-seller"] },
        version: 2,
      })) as never,
    });

    const response = await buildApp(services, platformAdminActor).request("/accounts/acc_1/badges", {
      method: "POST",
      body: JSON.stringify({ badgeKey: "trusted-seller" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "acc_1",
      badges: ["trusted-seller"],
    });
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: "AssignAccountBadge",
          badgeKey: "trusted-seller",
        },
        streamId: "identity.account-acc_1",
      }),
    );
  });

  it("rejects unsupported account badge keys", async () => {
    const services = buildServices();

    const response = await buildApp(services, platformAdminActor).request("/accounts/acc_1/badges", {
      method: "POST",
      body: JSON.stringify({ badgeKey: "vip" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects a platform admin attempting to remove the retired manual payout review badge", async () => {
    const services = buildServices({
      commandHandler: vi.fn(async () => ({
        state: { status: "active", badges: [] },
        version: 3,
      })) as never,
    });

    const response = await buildApp(services, platformAdminActor).request(
      "/accounts/acc_1/badges/manual-payout-review",
      { method: "DELETE" },
    );

    expect(response.status).toBe(400);
    expect(services.commandHandler).not.toHaveBeenCalled();
  });

  it("returns the command-side account when the account projection is not available", async () => {
    const services = buildServices({
      getAccountForRead: vi.fn(async () => ({
        account_id: "acc_1",
        account_type: "personal",
        badges: [],
        founder_number: null,
        founders_window_started_at: null,
        founders_window_ends_at: null,
        display_name: "Fresh Seller",
        name: "Fresh Seller",
        status: "active",
        updated_at: "",
      })),
    });

    const response = await buildApp(services).request("/accounts/acc_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account_id: "acc_1",
      display_name: "Fresh Seller",
      status: "active",
    });
    expect(services.getAccountForRead).toHaveBeenCalledWith("acc_1");
  });
});
