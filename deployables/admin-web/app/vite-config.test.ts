import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../vite.config.ts"), "utf8");

describe("admin web dev proxy", () => {
  it("proxies bounded-context admin API mounts used by contributed routes", () => {
    expect(configSource).toContain('"/api/experience"');
    expect(configSource).toContain('"/api/marketplace"');
  });
});
