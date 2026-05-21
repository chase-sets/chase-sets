import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "./services";
import { bootstrapPlatformAdminPassword } from "./production-bootstrap";

describe("platform admin password bootstrap", () => {
  it("upserts only the configured password credential", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const hashSecret = vi.fn((value: string) => `hashed:${value}`);
    const services = {
      db: { query },
      auth: { hashSecret },
    } as unknown as AuthServices;

    await bootstrapPlatformAdminPassword(services, {
      userId: "usr_platform_admin",
      credentialId: "crd_platform_admin_password",
      password: "rotate-me",
    });

    expect(hashSecret).toHaveBeenCalledWith("rotate-me");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("identity_password_credentials");
    expect(query.mock.calls[0]?.[0]).not.toContain("identity_session_tokens");
    expect(query.mock.calls[0]?.[1]).toEqual(["crd_platform_admin_password", "usr_platform_admin", "hashed:rotate-me"]);
  });
});
