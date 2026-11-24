import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clearedVariables,
  cortenMarketplaceSmokeInvocation,
  forcedSmokeEnvironment,
} from "./corten-marketplace-smoke.mjs";

const landing = "https://landing.example";
const admin = "https://admin.example";
const marketplace = "https://marketplace-corten.example";

describe("Corten marketplace smoke entry", () => {
  it("runs the platform smoke against the given marketplace origin, signed out", () => {
    const { args, env } = cortenMarketplaceSmokeInvocation(
      ["node", "corten-marketplace-smoke.mjs", "--", landing, admin, marketplace],
      {
        PLATFORM_ADMIN_EMAIL: "admin@example.test",
        PLATFORM_ADMIN_PASSWORD: "not-sent",
        SMOKE_REQUIRE_SOCIAL_LOGIN: "true",
        SMOKE_REQUIRE_LANDING: "true",
        SMOKE_REQUIRE_ADMIN: "true",
        SMOKE_REQUIRE_MARKETPLACE_ROOT: "true",
        SMOKE_WRITE_WAITLIST: "true",
        MARKETPLACE_WEB_URL: "https://marketplace.elsewhere.example",
        MARKETPLACE_ROOT_WEB_URL: "https://root.example",
      },
    );
    expect(args.slice(1)).toEqual([landing, admin, marketplace]);
    expect(args[0].replaceAll("\\", "/")).toMatch(/\/scripts\/platform-smoke\.mjs$/);
    expect(env).toMatchObject(forcedSmokeEnvironment);
    // Social login follows the caller, as the Smoke check decides it.
    expect(env.SMOKE_REQUIRE_SOCIAL_LOGIN).toBe("true");
    for (const name of clearedVariables) expect(env).not.toHaveProperty(name);
  });

  it("refuses anything but a landing, an admin and a marketplace origin", () => {
    expect(() => cortenMarketplaceSmokeInvocation(["node", "x", landing, admin], {})).toThrow(/Usage/);
    expect(() =>
      cortenMarketplaceSmokeInvocation(["node", "x", landing, admin, marketplace, "https://legacy.example"], {}),
    ).toThrow(/Usage/);
  });

  it("never fetches the admin host once the admin surface check is off", async () => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(503).end("admin is down");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const adminOrigin = `http://127.0.0.1:${server.address().port}`;
    const run = (extra) =>
      new Promise((resolve) => {
        const env = { ...process.env, NO_COLOR: "1" };
        for (const name of clearedVariables) delete env[name];
        Object.assign(env, forcedSmokeEnvironment, {
          SMOKE_REQUIRE_MARKETPLACE: "false",
          SMOKE_REQUIRE_NATIVE_MCP: "false",
          SMOKE_REQUIRE_SOCIAL_LOGIN: "false",
          SMOKE_FETCH_ATTEMPTS: "1",
          SMOKE_FETCH_RETRY_DELAY_MS: "1",
          ...extra,
        });
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL("./platform-smoke.mjs", import.meta.url)), landing, adminOrigin],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("close", (code) => resolve({ code, output }));
      });
    try {
      // The marketplace entry's setting: an admin that answers 503 is never asked.
      const skipped = await run({});
      expect(skipped.output).toContain("Platform smoke checks passed.");
      expect(skipped.code).toBe(0);
      expect(requests).toEqual([]);
      // The default still checks the admin home, so every other caller keeps that check.
      const checked = await run({ SMOKE_CHECK_ADMIN_SURFACE: "" });
      expect(checked.code).toBe(1);
      expect(requests[0]).toBe("/");
      // Turning the check off cannot hide an admin sign-in or SSO check.
      const refused = await run({ PLATFORM_ADMIN_EMAIL: "admin@example.test", PLATFORM_ADMIN_PASSWORD: "unused" });
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("SMOKE_CHECK_ADMIN_SURFACE=false cannot be combined");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
