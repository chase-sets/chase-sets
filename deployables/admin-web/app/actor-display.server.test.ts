import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateIdentityRequestApiClient, mockIdentityApi, mockRequestWithoutFreshWrite } = vi.hoisted(() => ({
  mockCreateIdentityRequestApiClient: vi.fn(),
  mockIdentityApi: { getCurrentActorDisplay: vi.fn() },
  mockRequestWithoutFreshWrite: vi.fn((request: Request) => request),
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityRequestApiClient: mockCreateIdentityRequestApiClient,
  requestWithoutFreshWrite: mockRequestWithoutFreshWrite,
}));

import { resolveAdminActorDisplay } from "./actor-display.server";

describe("resolveAdminActorDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateIdentityRequestApiClient.mockReturnValue(mockIdentityApi);
  });

  it("returns the current actor display fetched from Identity", async () => {
    const actorDisplay = {
      account: { account_id: "acc_card_vault", display_name: "Card Vault", name: "Card Vault LLC", badges: [] },
      membership: { membership_id: "mbr_1", role_key: "owner" },
      user: { user_id: "usr_1", display_name: "Alex Clerk", primary_email: "alex@example.com" },
    };
    mockIdentityApi.getCurrentActorDisplay.mockResolvedValue(actorDisplay);
    const request = new Request("https://admin.test/access/accounts");

    const result = await resolveAdminActorDisplay(request);

    expect(result).toEqual(actorDisplay);
    expect(mockRequestWithoutFreshWrite).toHaveBeenCalledWith(request);
    expect(mockCreateIdentityRequestApiClient).toHaveBeenCalledWith(request);
  });

  it("returns null when the fetch fails, so shell chrome can fall back gracefully", async () => {
    mockIdentityApi.getCurrentActorDisplay.mockRejectedValue(new Error("boom"));
    const request = new Request("https://admin.test/access/accounts");

    await expect(resolveAdminActorDisplay(request)).resolves.toBeNull();
  });
});
