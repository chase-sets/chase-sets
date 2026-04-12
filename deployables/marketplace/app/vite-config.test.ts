import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("marketplace vite config", () => {
  it("proxies auth api requests to platform-api during local dev", () => {
    const configSource = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(configSource).toContain("host: true");
    expect(configSource).toContain("allowedHosts");
    expect(configSource).toContain("cors:");
    expect(configSource).toContain('"/api/auth"');
    expect(configSource).toContain('target: "http://localhost:6182"');
  });
});
