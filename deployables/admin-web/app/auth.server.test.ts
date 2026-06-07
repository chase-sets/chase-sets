import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireActor, mockResolveActor } = vi.hoisted(() => ({
  mockRequireActor: vi.fn(),
  mockResolveActor: vi.fn(),
}));

vi.mock("@chase-sets/auth/server", () => ({
  defineAuthHost: () => ({
    requireActor: mockRequireActor,
    resolveActor: mockResolveActor,
  }),
}));

import { requireOperationsAdminActor, requireSignedInAdminActor } from "./auth.server";

describe("admin web auth helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows operations access for an actor with a visible operations capability", async () => {
    const actor = { permissions: ["support.manage"] };
    mockResolveActor.mockResolvedValue(actor);

    await expect(
      requireOperationsAdminActor(new Request("https://admin.test/operations/support-requests")),
    ).resolves.toBe(actor);
    expect(mockRequireActor).not.toHaveBeenCalled();
  });

  it("rejects signed-in actors without visible operations navigation", async () => {
    mockResolveActor.mockResolvedValue({ permissions: ["commercial-terms.view"] });

    await expect(requireOperationsAdminActor(new Request("https://admin.test/operations"))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("delegates signed-out operations actors to the auth challenge", async () => {
    const challengedActor = { permissions: ["security.manage"] };
    mockResolveActor.mockResolvedValue(null);
    mockRequireActor.mockResolvedValue(challengedActor);

    await expect(requireOperationsAdminActor(new Request("https://admin.test/operations"))).resolves.toBe(
      challengedActor,
    );
    expect(mockRequireActor).toHaveBeenCalledWith(expect.any(Request), "security.manage");
  });

  it("allows root hub loading for any signed-in actor before section filtering", async () => {
    const actor = { permissions: [] };
    mockResolveActor.mockResolvedValue(actor);

    await expect(requireSignedInAdminActor(new Request("https://admin.test/"))).resolves.toBe(actor);
    expect(mockRequireActor).not.toHaveBeenCalled();
  });
});
