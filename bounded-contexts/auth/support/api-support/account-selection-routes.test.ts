import {
  createAnonymousTestActor,
  createTestApp,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerAccountSelectionRoutes } from "./account-selection-routes";
import type { AuthApiEnv } from "./support";

const { mockGetAccountSelectionTokenByHash } = vi.hoisted(() => ({
  mockGetAccountSelectionTokenByHash: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({
  consumeAccountSelectionToken: vi.fn(),
  getAccountSelectionTokenByHash: mockGetAccountSelectionTokenByHash,
}));

function buildApp(services: AuthServices) {
  return createTestApp<AuthApiEnv>({
    actor: createAnonymousTestActor(),
    routes: (app) => {
      registerAccountSelectionRoutes(app, services);
    },
  });
}

useMockReset();

describe("account selection auth routes", () => {
  it("returns account display names and localized role labels from the selection contract", async () => {
    mockGetAccountSelectionTokenByHash.mockResolvedValue({
      user_id: "usr_seller",
      authentication_method: "password",
    });
    const query = vi.fn(async () => ({
      rows: [
        {
          account_id: "acc_competitive_cards",
          account_name: "Competitive Cards",
          role_key: "owner",
        },
      ],
    }));
    const services = {
      db: { query },
      auth: { hashSecret: vi.fn((value: string) => `hashed:${value}`) },
    } as unknown as AuthServices;
    const app = buildApp(services);

    const response = await app.request("/account-selection/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectionToken: "selection_token" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "usr_seller",
      memberships: [
        {
          accountId: "acc_competitive_cards",
          accountName: "Competitive Cards",
          roleLabel: "Owner",
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INNER JOIN auth_identity_accounts"), ["usr_seller"]);
  });
});
