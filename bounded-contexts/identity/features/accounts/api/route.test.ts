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

describe("account API route", () => {
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

  it("allows a platform admin to remove an account badge", async () => {
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

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "acc_1",
      badges: [],
    });
    expect(services.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          type: "RemoveAccountBadge",
          badgeKey: "manual-payout-review",
        },
        streamId: "identity.account-acc_1",
      }),
    );
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
