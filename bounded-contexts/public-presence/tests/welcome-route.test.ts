import { describe, expect, it, vi } from "vitest";
import { loader, meta } from "../routes/marketplace/welcome";

describe("public presence welcome route", () => {
  it("resolves the signup id and attribution flag from the query string", async () => {
    const data = await loader({
      request: new Request("https://chasesets.test/welcome?signup=wls_public&fresh=1&attributed=1"),
      params: {},
      context: undefined,
    } as never);

    expect(data.signupId).toBe("wls_public");
    expect(data.attributed).toBe(true);
    expect(data.publicOrigin).toBe("https://chasesets.test");
  });

  it("defaults attributed to false when the redirect did not carry it", async () => {
    const data = await loader({
      request: new Request("https://chasesets.test/welcome?signup=wls_public"),
      params: {},
      context: undefined,
    } as never);

    expect(data.attributed).toBe(false);
  });

  it("404s when the signup id is missing or malformed", async () => {
    await expect(
      loader({
        request: new Request("https://chasesets.test/welcome"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      loader({
        request: new Request("https://chasesets.test/welcome?signup=<script>"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the success page out of search results", () => {
    expect(meta({} as never)).toContainEqual({ name: "robots", content: "noindex, nofollow" });
  });

  it("warns loudly outside production when the Discord invite URL is unconfigured", async () => {
    const originalDiscordUrl = process.env.CHASE_SETS_DISCORD_INVITE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.CHASE_SETS_DISCORD_INVITE_URL;
    process.env.NODE_ENV = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const data = await loader({
        request: new Request("https://chasesets.test/welcome?signup=wls_public"),
        params: {},
        context: undefined,
      } as never);

      expect(data.discordInviteUrl).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("CHASE_SETS_DISCORD_INVITE_URL"));
    } finally {
      warn.mockRestore();
      if (originalDiscordUrl === undefined) {
        delete process.env.CHASE_SETS_DISCORD_INVITE_URL;
      } else {
        process.env.CHASE_SETS_DISCORD_INVITE_URL = originalDiscordUrl;
      }
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
