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

import { requireAdminSectionActor, requireSignedInAdminActor } from "./auth.server";

describe("admin web auth helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows section access for an actor with visible section capability", async () => {
    const actor = { permissions: ["support.manage"] };
    mockResolveActor.mockResolvedValue(actor);

    await expect(
      requireAdminSectionActor(new Request("https://admin.test/support/requests"), "support", "support.manage"),
    ).resolves.toBe(actor);
    expect(mockRequireActor).not.toHaveBeenCalled();
  });

  it("rejects signed-in actors without visible section navigation", async () => {
    mockResolveActor.mockResolvedValue({ permissions: ["commercial-terms.view"] });

    await expect(
      requireAdminSectionActor(new Request("https://admin.test/platform"), "platform", "security.manage"),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it("delegates signed-out section actors to the auth challenge", async () => {
    const challengedActor = { permissions: ["security.manage"] };
    mockResolveActor.mockResolvedValue(null);
    mockRequireActor.mockResolvedValue(challengedActor);

    await expect(
      requireAdminSectionActor(new Request("https://admin.test/platform"), "platform", "security.manage"),
    ).resolves.toBe(challengedActor);
    expect(mockRequireActor).toHaveBeenCalledWith(expect.any(Request), "security.manage");
  });

  it("allows root hub loading for any signed-in actor before section filtering", async () => {
    const actor = { permissions: [] };
    mockResolveActor.mockResolvedValue(actor);

    await expect(requireSignedInAdminActor(new Request("https://admin.test/"))).resolves.toBe(actor);
    expect(mockRequireActor).not.toHaveBeenCalled();
  });

  it("challenges signed-out root hub entry without requiring Access permissions", async () => {
    const challengedActor = { permissions: ["platform-feedback.view"] };
    mockResolveActor.mockResolvedValue(null);
    mockRequireActor.mockResolvedValue(challengedActor);

    await expect(requireSignedInAdminActor(new Request("https://admin.test/"))).resolves.toBe(challengedActor);
    expect(mockRequireActor).toHaveBeenCalledWith(expect.any(Request), "");
  });
});
