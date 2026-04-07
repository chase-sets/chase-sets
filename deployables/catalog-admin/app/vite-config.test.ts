import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("catalog admin vite config", () => {
  it("proxies auth api requests to identity-api during local dev", () => {
    const configSource = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(configSource).toContain('"/api/auth"');
    expect(configSource).toContain('target: "http://localhost:6181"');
  });
});
